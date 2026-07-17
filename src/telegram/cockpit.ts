// Cockpit: owns live sessions/watchers and renders their events into Telegram.
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import fs from "node:fs";
import path from "node:path";
import { BridgeConfig, saveConfig, type AccountCfg } from "../config.js";
import { configDirOf } from "../core/inventory.js";
import { ManagedSession, type PendingApproval, type RateInfo } from "../core/sessionManager.js";
import { watchTranscript, type WatchHandle } from "../core/observer.js";
import { accountUsage, noteRateEvent } from "../core/usage.js";
import type { SessionRec, Store } from "../state.js";
import { chunk, esc, fmtReset, fmtTokens, mdToHtml, toolLine } from "./render.js";

const EDIT_MIN_MS = 1600;
const TOOL_FLUSH_MS = 2000;

interface Draft { msgId?: number; lastEdit: number; text: string; timer?: NodeJS.Timeout }

export class Cockpit {
  api: Api;
  cfg: BridgeConfig;
  store: Store;
  live = new Map<string, ManagedSession>();
  watchers = new Map<string, WatchHandle>();
  approvals = new Map<string, PendingApproval>();
  // Foreign-session permission/plan prompts awaiting a Telegram tap. `input` is kept so an
  // "always allow" grant can be scoped to this exact call (cwd + tool + input hash), never
  // to the whole tool.
  foreignApprovals = new Map<string, { resolve: (v: { decision: "allow" | "deny" | "ask"; reason?: string }) => void; messageId?: number; tool: string; cwd: string; input: Record<string, unknown> }>();
  private drafts = new Map<string, Draft>();
  private toolBuf = new Map<string, string[]>();
  private warned5h = new Set<string>();

  constructor(api: Api, cfg: BridgeConfig, store: Store) {
    this.api = api;
    this.cfg = cfg;
    this.store = store;
  }

  account(name: string): AccountCfg {
    return this.cfg.accounts.find((a) => a.name === name) ?? this.cfg.accounts[0];
  }

  /** Ask the owner (via Telegram) to decide a permission or plan from a FOREIGN (desktop/
   *  terminal) session. Resolves 'ask' on timeout so the normal desktop prompt takes over. */
  askForeign(id: string, tool: string, cwd: string, input: Record<string, unknown>, waitMs: number): Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.foreignApprovals.delete(id)) resolve({ decision: "ask" }); }, waitMs);
      this.foreignApprovals.set(id, { tool, cwd, input, resolve: (v) => { clearTimeout(timer); this.foreignApprovals.delete(id); resolve(v); } });
      const away = "<i>You're away from the Mac, so this came to your phone. No answer in ~2 min → it waits on the Mac.</i>";
      if (tool === "ExitPlanMode") {
        const plan = mdToHtml(String(input.plan ?? "(empty plan)")).slice(0, 3200);
        const kb = new InlineKeyboard()
          .text("✅ Approve", `fp:${id}:pa`).text("❌ Reject", `fp:${id}:px`).row()
          .text("✏️ Revise (send feedback)", `fp:${id}:pv`);
        void this.say(null, `📋 <b>Away-mode: plan ready in a desktop session</b>\n<code>${esc(cwd)}</code>\n\n${plan}\n\n${away}`, kb)
          .then((mid) => { const e = this.foreignApprovals.get(id); if (e) e.messageId = mid; });
        return;
      }
      const preview = JSON.stringify(input, null, 1).slice(0, 700);
      const kb = new InlineKeyboard()
        .text("✅ Allow once", `fp:${id}:a`).text("❌ Deny", `fp:${id}:d`).row()
        .text(`♾ Always allow this exact ${tool} call`, `fp:${id}:w`);
      void this.say(null,
        `🖥️ <b>Away-mode: a desktop/terminal session wants ${esc(tool)}</b>\n` +
        `<code>${esc(cwd)}</code>\n<pre><code>${esc(preview)}</code></pre>\n${away}`,
        kb,
      ).then((mid) => { const e = this.foreignApprovals.get(id); if (e) e.messageId = mid; });
    });
  }

  threadOpts(rec: SessionRec): { message_thread_id?: number } {
    return rec.topicId ? { message_thread_id: rec.topicId } : {};
  }

  /** Send HTML (chunked); falls back to plain text if Telegram rejects the HTML. */
  async say(rec: SessionRec | null, html: string, keyboard?: InlineKeyboard, opts?: { silent?: boolean }): Promise<number | undefined> {
    const chatId = this.cfg.chatId;
    if (!chatId) return undefined;
    const extra = rec ? this.threadOpts(rec) : {};
    const quiet = opts?.silent ? { disable_notification: true } : {};
    let lastId: number | undefined;
    const pieces = chunk(html);
    for (let i = 0; i < pieces.length; i++) {
      const kb = i === pieces.length - 1 && keyboard ? { reply_markup: keyboard } : {};
      try {
        const m = await this.api.sendMessage(chatId, pieces[i], { parse_mode: "HTML", ...extra, ...kb, ...quiet });
        lastId = m.message_id;
      } catch {
        try {
          const m = await this.api.sendMessage(chatId, pieces[i].replace(/<[^>]+>/g, ""), { ...extra, ...kb, ...quiet });
          lastId = m.message_id;
        } catch { /* give up on this piece */ }
      }
    }
    return lastId;
  }

  /** Create a forum topic for a session; flips to flat mode if the chat can't do topics. */
  async makeTopic(name: string): Promise<number | undefined> {
    if (!this.cfg.chatId || this.cfg.forumMode === false) return undefined;
    try {
      const t = await this.api.createForumTopic(this.cfg.chatId, name.slice(0, 100));
      this.cfg.forumMode = true;
      saveConfig(this.cfg);
      return t.message_thread_id;
    } catch {
      if (this.cfg.forumMode === undefined) {
        this.cfg.forumMode = false;
        saveConfig(this.cfg);
        await this.say(null, "ℹ️ This chat doesn't support topics — running in flat mode (one conversation, /use to switch the active session). To get one-topic-per-session, create a private <b>forum</b> group, add the bot as admin, and /start there.");
      }
      return undefined;
    }
  }

  /** Spawn a managed session (new or resume) and wire its events. */
  async spawn(rec: SessionRec, opts: { firstPrompt?: string; resume?: string } = {}): Promise<ManagedSession> {
    const sess = new ManagedSession(rec, this.account(rec.account), {
      onText: (s, text, final) => void this.renderText(s, text, final),
      onToolUse: (s, name, input) => this.renderTool(s, name, input),
      onApproval: (s, a) => void this.renderApproval(s, a),
      onResult: (s, info) => void this.renderResult(s, info),
      onRateLimit: (s, info) => void this.renderRate(s, info),
      onNote: (s, note) => void this.say(s.rec, note),
      onExit: (s, reason) => void this.onExit(s, reason),
    });
    this.live.set(rec.key, sess);
    this.store.sessions.set(rec.key, rec);
    this.store.flushSessions();
    sess.start(opts.firstPrompt, opts.resume);
    return sess;
  }

  private async renderText(s: ManagedSession, text: string, final: boolean): Promise<void> {
    const key = s.rec.key;
    const chatId = this.cfg.chatId;
    if (!chatId) return;
    const d = this.drafts.get(key) ?? { lastEdit: 0, text: "" };
    this.drafts.set(key, d);
    d.text = text;
    if (final) {
      if (d.timer) { clearTimeout(d.timer); d.timer = undefined; }
      const html = mdToHtml(text);
      const pieces = chunk(html);
      if (d.msgId) {
        try { await this.api.editMessageText(chatId, d.msgId, pieces[0], { parse_mode: "HTML" }); }
        catch { /* content identical or too old — fine */ }
        for (const p of pieces.slice(1)) await this.say(s.rec, p);
      } else {
        for (const p of pieces) await this.say(s.rec, p);
      }
      this.drafts.delete(key);
      return;
    }
    const flush = async (): Promise<void> => {
      d.lastEdit = Date.now();
      const preview = d.text.length > 3600 ? "…" + d.text.slice(-3600) : d.text;
      try {
        if (!d.msgId) {
          const m = await this.api.sendMessage(chatId, esc(preview) + " ▌", { ...this.threadOpts(s.rec) });
          d.msgId = m.message_id;
        } else {
          await this.api.editMessageText(chatId, d.msgId, esc(preview) + " ▌");
        }
      } catch { /* edit races are fine */ }
    };
    if (Date.now() - d.lastEdit >= EDIT_MIN_MS && !d.timer) void flush();
    else if (!d.timer) d.timer = setTimeout(() => { d.timer = undefined; void flush(); }, EDIT_MIN_MS);
  }

  private renderTool(s: ManagedSession, name: string, input: Record<string, unknown>): void {
    const key = s.rec.key;
    const buf = this.toolBuf.get(key) ?? [];
    buf.push(toolLine(name, input));
    this.toolBuf.set(key, buf);
    if (buf.length === 1) {
      setTimeout(() => {
        const lines = this.toolBuf.get(key) ?? [];
        this.toolBuf.set(key, []);
        if (lines.length) void this.say(s.rec, lines.join("\n"));
      }, TOOL_FLUSH_MS);
    }
  }

  private async renderApproval(s: ManagedSession, a: PendingApproval): Promise<void> {
    this.approvals.set(a.id, a);
    // Fail-safe (review finding #8): if this prompt is never answered — or the Telegram send below
    // fails — auto-deny after the configured timeout so the SDK tool call can't hang the session
    // forever. Any real answer (or the abort listener) goes through a.resolve, which clears the timer.
    const timer = setTimeout(() => {
      this.approvals.delete(a.id);
      if (a.messageId && this.cfg.chatId)
        void this.api.editMessageText(this.cfg.chatId, a.messageId, "⌛ timed out — no response; falling back to the safe default.").catch(() => undefined);
      a.resolve({ behavior: "deny", message: "Timed out awaiting a Telegram response." });
    }, (this.cfg.approvalTimeoutMin ?? 15) * 60_000);
    const origResolve = a.resolve;
    a.resolve = (r): void => { clearTimeout(timer); origResolve(r); };
    // If the prompt never reached Telegram (no chatId / all sends failed), don't dangle — deny now.
    const guardDelivery = (): void => {
      if (a.messageId === undefined) a.resolve({ behavior: "deny", message: "Couldn't deliver the approval prompt to Telegram." });
    };
    if (a.kind === "plan") {
      const kb = new InlineKeyboard()
        .text("✅ Approve → auto-accept edits", `pl:${a.id}:a`).row()
        .text("✅ Approve (manual approvals)", `pl:${a.id}:m`).row()
        .text("✏️ Revise", `pl:${a.id}:r`).text("❌ Reject", `pl:${a.id}:x`);
      const plan = mdToHtml(String(a.input.plan ?? "(empty plan)"));
      a.messageId = await this.say(s.rec, `📋 <b>Plan ready for review</b>\n\n${plan}`, kb);
      guardDelivery();
      return;
    }
    if (a.kind === "question") {
      const q = (a.input.questions as Array<Record<string, unknown>> | undefined)?.[0];
      const kb = new InlineKeyboard();
      const opts = (q?.options as Array<{ label: string; description?: string }> | undefined) ?? [];
      opts.forEach((o, i) => kb.text(o.label.slice(0, 60), `q:${a.id}:${i}`).row());
      kb.text("✍️ Other…", `q:${a.id}:o`);
      const lines = opts.map((o, i) => `${i + 1}. <b>${esc(o.label)}</b>${o.description ? ` — ${esc(o.description)}` : ""}`);
      a.messageId = await this.say(s.rec, `❓ <b>${esc(String(q?.question ?? "Claude asks:"))}</b>\n\n${lines.join("\n")}`, kb);
      guardDelivery();
      return;
    }
    const title = a.title ?? `Claude wants to use ${a.toolName}`;
    const preview = JSON.stringify(a.input, null, 1).slice(0, 800);
    const kb = new InlineKeyboard()
      .text("✅ Allow once", `p:${a.id}:a`)
      .text("❌ Deny", `p:${a.id}:d`).row()
      .text("♾ Always allow…", `p:${a.id}:w`);
    a.messageId = await this.say(
      s.rec,
      `🔐 <b>${esc(title)}</b>${a.description ? `\n${esc(a.description)}` : ""}\n<pre><code>${esc(preview)}</code></pre>`,
      kb,
    );
    guardDelivery();
  }

  private async renderResult(s: ManagedSession, info: { costUsd?: number; turns?: number; isError: boolean; subtype: string }): Promise<void> {
    const [ctx, acct] = await Promise.all([
      s.contextUsage(),
      accountUsage(this.account(s.rec.account)).catch(() => ({}) as Awaited<ReturnType<typeof accountUsage>>),
    ]);
    const head = [info.isError ? `⚠️ ${info.subtype}` : "✅ done"];
    if (info.turns) head.push(`${info.turns} turns`);
    if (info.costUsd) head.push(`$${info.costUsd.toFixed(2)}`);
    const usage: string[] = [];
    if (ctx) usage.push(`ctx ${Math.round(ctx.percentage)}% (${fmtTokens(ctx.totalTokens)}/${fmtTokens(ctx.maxTokens)})`);
    if (acct.fiveHour?.pct !== undefined) usage.push(`5h ${Math.round(acct.fiveHour.pct!)}%${acct.fiveHour.resetsAt ? ` ${fmtReset(acct.fiveHour.resetsAt)}` : ""}`);
    if (acct.sevenDay?.pct !== undefined) usage.push(`wk ${Math.round(acct.sevenDay.pct!)}%${acct.sevenDay.resetsAt ? ` ${fmtReset(acct.sevenDay.resetsAt)}` : ""}`);
    if (usage.length) usage.push(`<code>${esc(s.rec.account)}</code>`);
    this.store.flushSessions();
    const lines = [head.join(" · "), ...(usage.length ? [usage.join(" · ")] : [])];
    // Pool exhausted → offer to move THIS session (history intact) to another account.
    let kb: InlineKeyboard | undefined;
    if ((acct.fiveHour?.pct ?? 0) >= 99 && this.cfg.accounts.length > 1) {
      kb = new InlineKeyboard();
      this.cfg.accounts.forEach((a, i) => {
        if (a.name !== s.rec.account) kb!.text(`🔁 Switch this session to ${a.name}`, `sw:${s.rec.key}:${i}`).row();
      });
      lines.push("5-hour pool is full — move this conversation to another account:");
    }
    await this.say(s.rec, `<i>${lines.join("\n")}</i>`, kb);
  }

  private async renderRate(s: ManagedSession, info: RateInfo): Promise<void> {
    noteRateEvent(info);
    if (info.rateLimitType === "five_hour" && (info.utilization ?? 0) >= this.cfg.usageWarnPct) {
      const stamp = `${info.account}:${Math.floor((info.resetsAt ?? 0) / 3600)}`;
      if (!this.warned5h.has(stamp)) {
        this.warned5h.add(stamp);
        await this.say(null, `🚨 <b>${esc(info.account)}</b>: 5-hour window at ${Math.round(info.utilization ?? 0)}%. Consider /stop or waiting for the reset.`);
      }
    }
  }

  /** Keys being intentionally killed (account move / respawn) — suppress the detach notice. */
  private restarting = new Set<string>();

  private async onExit(s: ManagedSession, reason: string): Promise<void> {
    this.store.flushSessions();
    for (const [id, a] of this.approvals) if (a.sessionKey === s.rec.key) this.approvals.delete(id);
    if (this.restarting.has(s.rec.key)) return; // moveSession/respawn manage `live` themselves
    // A dead session must NOT linger in `live` (review finding #4): otherwise typed input routes
    // into its closed queue and silently vanishes instead of triggering a resume. Only delete if
    // the live entry is still this exact session (guard against a restart race replacing it).
    if (this.live.get(s.rec.key) === s) this.live.delete(s.rec.key);
    const note = s.rec.status === "closed" ? "🏁 session ended" : `💤 session detached (${esc(reason)}) — Resume with /sessions`;
    await this.say(s.rec, `<i>${note}</i>`);
  }

  /** Watch a foreign session's transcript into a topic (or the flat chat).
   *  Mirrored events batch into one SILENT message every ~2.5s — a busy session
   *  must not become 50 separate phone notifications. */
  async watch(file: string, rec: SessionRec): Promise<void> {
    const buf: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!buf.length) return;
      const msg = buf.join("\n");
      buf.length = 0;
      void this.say(rec, msg, undefined, { silent: true });
    };
    const push = (line: string): void => {
      buf.push(line);
      if (buf.length >= 40) return flush();
      if (!timer) timer = setTimeout(flush, 2500);
    };
    const handle = watchTranscript(file, (kind, text, input) => {
      if (kind === "assistant") push(mdToHtml(text));
      else if (kind === "user") push(`👤 <i>${esc(text.slice(0, 500))}</i>`);
      else push(toolLine(text, input ?? {}));
    });
    this.watchers.set(rec.key, { stop: () => { handle.stop(); flush(); } });
    rec.status = "watching";
    this.store.sessions.set(rec.key, rec);
    this.store.flushSessions();
  }

  unwatch(rec: SessionRec): void {
    this.watchers.get(rec.key)?.stop();
    this.watchers.delete(rec.key);
    rec.status = "closed";
    this.store.flushSessions();
  }

  /** Move a session to another account: copy its transcript (+ sidecars) into the
   *  target account's config-dir store, then respawn-resume there. History intact,
   *  fresh limit pool. */
  async moveSession(rec: SessionRec, target: AccountCfg): Promise<void> {
    const source = this.account(rec.account);
    this.restarting.add(rec.key);
    setTimeout(() => this.restarting.delete(rec.key), 8000);
    const sess = this.live.get(rec.key);
    if (sess) { sess.kill(); this.live.delete(rec.key); }
    if (rec.sessionId) {
      const enc = rec.cwd.replace(/[^a-zA-Z0-9]/g, "-");
      const srcDir = path.join(configDirOf(source), "projects", enc);
      const dstDir = path.join(configDirOf(target), "projects", enc);
      const src = path.join(srcDir, `${rec.sessionId}.jsonl`);
      try {
        if (!fs.existsSync(src)) throw new Error("source transcript not found");
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(src, path.join(dstDir, `${rec.sessionId}.jsonl`));
        const sideSrc = path.join(srcDir, rec.sessionId); // tool-results / subagents sidecar dir
        if (fs.existsSync(sideSrc)) fs.cpSync(sideSrc, path.join(dstDir, rec.sessionId), { recursive: true, force: true });
      } catch (e) {
        // Copy failed → do NOT switch accounts: resuming on the target with a missing/partial
        // transcript would lose history. Keep the session on its current account and resume it
        // there so it isn't lost.
        await this.say(rec, `⚠️ Couldn't copy this session's history to <b>${esc(target.name)}</b> (${esc(e instanceof Error ? e.message : String(e))}). Staying on <b>${esc(source.name)}</b>.`);
        rec.status = "idle";
        this.store.flushSessions();
        await this.spawn(rec, { resume: rec.sessionId });
        return;
      }
    }
    rec.account = target.name;
    rec.status = "idle";
    this.store.flushSessions();
    await this.spawn(rec, rec.sessionId ? { resume: rec.sessionId } : {});
  }

  /** Restart a session's engine with changed spawn-time options (e.g. effort). */
  async respawn(sess: ManagedSession, changes: Partial<Pick<SessionRec, "effort" | "model" | "mode">>): Promise<void> {
    const rec = sess.rec;
    const resumeId = rec.sessionId;
    this.restarting.add(rec.key);
    setTimeout(() => this.restarting.delete(rec.key), 8000);
    sess.kill();
    this.live.delete(rec.key);
    Object.assign(rec, changes);
    rec.status = "idle";
    await this.spawn(rec, { resume: resumeId });
  }

  titleFor(cwd: string, extra?: string): string {
    return `${path.basename(cwd)}${extra ? ` · ${extra}` : ""}`.slice(0, 96);
  }
}
