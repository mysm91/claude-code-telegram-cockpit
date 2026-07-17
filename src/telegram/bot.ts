// Telegram command + callback layer. Single-owner: the first middleware drops every
// update that is not from the paired owner id (silently, logged).
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { BridgeConfig, saveConfig, STATE_DIR } from "../config.js";
import { addToGroup, desktopGroupNames, removeFromGroup } from "../core/groups.js";
import { configDirOf, listLocalSessions, listPlans, listRoutines, sessionCwd, sessionMeta, sessionTail, sessionTasks, type LocalSession } from "../core/inventory.js";
import { disableForeign, enableForeign, ensureForeignState, foreignState } from "../core/foreignPerms.js";
import { startPermServer } from "../core/permServer.js";
import { accountConnected, accountUsage, transcriptContextPct } from "../core/usage.js";
import type { SessionRec, Store } from "../state.js";
import { Cockpit } from "./cockpit.js";
import { esc, fmtAgo, fmtPct, fmtReset, fmtTokens, mdToHtml } from "./render.js";

const execFileP = promisify(execFile);
// Same naming as Claude Code's own mode menu ("default" is what the desktop calls "Ask permissions").
const MODES: Array<{ id: string; label: string; hint: string }> = [
  { id: "default", label: "Ask permissions", hint: "asks before sensitive actions — Claude Code's standard default" },
  { id: "acceptEdits", label: "Accept edits", hint: "file edits auto-approved; other actions still ask" },
  { id: "plan", label: "Plan mode", hint: "read-only research, then a plan you approve" },
  { id: "auto", label: "Auto mode", hint: "a safety classifier auto-approves safe actions, asks otherwise" },
  { id: "dontAsk", label: "Don't ask", hint: "never prompts — actions that would ask are denied" },
  { id: "bypassPermissions", label: "Bypass permissions", hint: "everything allowed, no prompts — use with care" },
];
const modeLabel = (id: string): string => MODES.find((m) => m.id === id)?.label ?? id;
// Desktop slider order, smartest first: Ultracode > Max > Extra > High > Medium > Low.
const EFFORTS: Array<{ id: string; label: string; hint: string }> = [
  { id: "ultracode", label: "Ultracode", hint: "Extra effort + standing multi-agent workflow orchestration — most thorough, token-hungry" },
  { id: "max", label: "Max", hint: "maximum reasoning effort (switches via a quick respawn+resume)" },
  { id: "xhigh", label: "Extra", hint: "extra-high effort — your global default" },
  { id: "high", label: "High", hint: "strong reasoning for normal work" },
  { id: "medium", label: "Medium", hint: "balanced speed and depth" },
  { id: "low", label: "Low", hint: "fastest and lightest" },
];
const effortLabel = (id?: string): string => (id ? EFFORTS.find((e) => e.id === id)?.label ?? id : "Extra (global default)");
const modelVersion = (m: { id: string; label: string; description: string }): string =>
  m.id === "default" ? m.label : (m.description.split("·")[0]?.trim() || m.label).replace(" with 1M context", " (1M)");
const SESSIONS_PER_PAGE = 10;
const shortPath = (p: string): string => p.replace(/^\/Users\//, "");

type Awaiting =
  | { type: "dir" }
  | { type: "planFeedback"; aid: string }
  | { type: "questionOther"; aid: string; qIdx: number };

export function createBot(token: string, cfg: BridgeConfig, store: Store): { bot: Bot; cockpit: Cockpit } {
  const bot = new Bot(token);
  bot.api.config.use(autoRetry());
  // Bulletproof every HTML send: if Telegram rejects the entities (a stray unescaped
  // <…> in some title/path/output), transparently resend as plain text instead of
  // failing the whole update. Covers all present + future code paths.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    const p = payload as { parse_mode?: string; text?: string; caption?: string };
    if (!res.ok && (res as { error_code?: number }).error_code === 400 &&
        /can't parse entities/i.test((res as { description?: string }).description ?? "") &&
        p.parse_mode && (method === "sendMessage" || method === "editMessageText")) {
      const stripped = { ...payload, parse_mode: undefined } as typeof payload & { text?: string };
      if (typeof p.text === "string") stripped.text = p.text.replace(/<[^>]+>/g, "");
      return prev(method, stripped, signal);
    }
    return res;
  });
  // Never let one failed handler silence the bot (that was the "nothing happens" bug).
  bot.catch((err) => {
    console.error("bot.catch:", err.error instanceof Error ? err.error.message : err.error);
  });
  const cockpit = new Cockpit(bot.api, cfg, store);

  // Pairing hardening (review finding #11): 64-bit code, 15-minute expiry with rotation,
  // failed-attempt lockout, 0600 code file that is deleted once pairing succeeds.
  const PAIR_TTL_MS = 15 * 60_000;
  const PAIR_MAX_FAILS = 5;
  const PAIR_LOCK_MS = 15 * 60_000;
  const PAIR_FILE = path.join(STATE_DIR, "pairing-code.txt");
  let pairingIssuedAt = 0;
  let pairFails = 0;
  let pairLockUntil = 0;
  function issuePairingCode(): string {
    pairingIssuedAt = Date.now();
    const code = randomBytes(8).toString("base64url"); // 64 bits
    console.log(`\n=== claude-tg-bridge pairing code: ${code}  (send it to the bot in Telegram; valid ${PAIR_TTL_MS / 60_000} min) ===\n`);
    fs.writeFileSync(PAIR_FILE, code + "\n", { mode: 0o600 });
    try { fs.chmodSync(PAIR_FILE, 0o600); } catch { /* best-effort on pre-existing file */ }
    return code;
  }
  let pairingCode = cfg.ownerId ? null : issuePairingCode();

  let activeKey: string | null = null; // flat-mode active session
  const awaiting = new Map<string, Awaiting>(); // threadKey -> pending input
  const qState = new Map<string, Map<number, Set<number> | string>>(); // AskUserQuestion selections per approval id
  let lastList: LocalSession[] = [];

  // Opaque callback refs (review finding #6): callback_data must never carry a bare index into a
  // mutable module-level array — those arrays are rebuilt on every /sessions//new//plans, so a
  // stale button would act on whatever now sits at that index (including the SIGKILL path).
  // Buttons carry a short random ref that resolves to the stable identity (session id / path);
  // handlers re-look the target up in CURRENT state and refuse when it's gone. 30-min TTL.
  const refs = new Map<string, { kind: string; val: string; at: number }>();
  const REF_TTL_MS = 30 * 60_000;
  function putRef(kind: string, val: string): string {
    if (refs.size > 4000) { const now = Date.now(); for (const [k, r] of refs) if (now - r.at > REF_TTL_MS) refs.delete(k); }
    const id = randomBytes(4).toString("base64url"); // 6 chars; alphabet has no ':' so split() stays safe
    refs.set(id, { kind, val, at: Date.now() });
    return id;
  }
  function getRef(kind: string, id: string | undefined): string | null {
    const r = id ? refs.get(id) : undefined;
    if (!r || r.kind !== kind || Date.now() - r.at > REF_TTL_MS) return null;
    return r.val;
  }

  const threadKey = (ctx: Context): string => `${ctx.chat?.id}:${(ctx.message ?? ctx.callbackQuery?.message)?.message_thread_id ?? 0}`;

  const recOf = (ctx: Context): SessionRec | undefined => {
    const tid = (ctx.message ?? ctx.callbackQuery?.message)?.message_thread_id;
    if (cfg.forumMode && tid) return store.byTopic(tid);
    if (activeKey) return store.sessions.get(activeKey);
    return undefined;
  };

  // ---- middleware: pairing + allowlist ----
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!cfg.ownerId) {
      const text = ctx.message?.text?.trim();
      if (!text || !uid) return; // unpaired: only text can pair; ignore everything else
      const now = Date.now();
      if (now < pairLockUntil) return; // lockout after repeated failures — drop silently
      if (pairingCode && now - pairingIssuedAt > PAIR_TTL_MS) pairingCode = issuePairingCode(); // expired → rotate (old code dead)
      if (pairingCode && text === pairingCode) {
        cfg.ownerId = uid;
        cfg.chatId = ctx.chat?.id;
        if (ctx.chat?.type === "supergroup" && (ctx.chat as { is_forum?: boolean }).is_forum) cfg.forumMode = true;
        saveConfig(cfg);
        pairingCode = null;
        try { fs.unlinkSync(PAIR_FILE); } catch { /* already gone */ }
        await ctx.reply("🔗 Paired. This bot now answers only to you.\nUse /help to see what it can do, /new to start a session.");
        return;
      }
      if (++pairFails >= PAIR_MAX_FAILS) {
        pairFails = 0;
        pairLockUntil = now + PAIR_LOCK_MS;
        pairingCode = issuePairingCode(); // rotate so a brute-forcer starts over after the lockout
        console.log(`pairing: ${PAIR_MAX_FAILS} failed attempts — locked ${PAIR_LOCK_MS / 60_000} min, code rotated`);
      }
      return;
    }
    if (uid !== cfg.ownerId) {
      console.log(`dropped update from non-owner ${uid}`);
      return;
    }
    if (!cfg.chatId && ctx.chat) { cfg.chatId = ctx.chat.id; saveConfig(cfg); }
    await next();
  });

  // ---- helpers ----
  async function startSession(cwd: string, firstPrompt?: string, opts: Partial<SessionRec> = {}): Promise<SessionRec | null> {
    try { if (!fs.statSync(cwd).isDirectory()) return null; } catch { return null; }
    const rec: SessionRec = {
      key: store.newKey(),
      cwd,
      account: cfg.activeAccount,
      mode: opts.mode ?? cfg.defaults.mode,
      model: opts.model ?? cfg.defaults.model,
      effort: opts.effort ?? cfg.defaults.effort,
      status: "running",
      kind: "managed",
      title: undefined,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      ...opts,
    };
    rec.title = opts.title ?? cockpit.titleFor(cwd);
    rec.topicId = await cockpit.makeTopic(`🤖 ${rec.title}`);
    activeKey = rec.key;
    await cockpit.spawn(rec, { firstPrompt, resume: opts.sessionId });
    await cockpit.say(rec, `🚀 <b>${esc(rec.title ?? cwd)}</b>\n<code>${esc(cwd)}</code>\naccount <b>${esc(rec.account)}</b> · mode <b>${rec.mode}</b>${rec.model ? ` · model <b>${esc(rec.model)}</b>` : ""}${rec.effort ? ` · effort <b>${rec.effort}</b>` : ""}\n${firstPrompt ? "" : "Type your first message."}`);
    return rec;
  }

  let newDirs: string[] = []; // cache backing the /new directory buttons (index must match the picker)
  let newDirsPage = 0;
  const DIRS_PER_PAGE = 10;

  // Every project folder that has a session anywhere on the Mac (all accounts),
  // most-recently-used first. Uses each session's REAL cwd (from the transcript) and
  // verifies the folder still exists — so no lossy-decoded or dead paths get offered.
  async function projectDirs(): Promise<string[]> {
    const seen = new Set<string>();
    const ordered: string[] = [];
    const add = (d?: string | null): void => {
      if (d && !seen.has(d) && fs.existsSync(d)) { seen.add(d); ordered.push(d); }
    };
    for (const s of [...store.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)) add(s.cwd);
    try {
      const { sessions } = await listLocalSessions(cfg.accounts, 300); // sorted live-first, then newest
      for (const s of sessions) add(sessionCwd(s.file)); // real cwd only — never the lossy folder-name guess
    } catch { /* fall back to bridge dirs only */ }
    add(process.env.HOME); // home dir as a sensible default entry
    return ordered;
  }

  const newDirsKb = (page: number): InlineKeyboard => {
    const kb = new InlineKeyboard();
    const start = page * DIRS_PER_PAGE;
    newDirs.slice(start, start + DIRS_PER_PAGE).forEach((d, i) => {
      const label = shortPath(d);
      kb.text(label.length > 42 ? "…" + label.slice(-40) : label, `dir:${putRef("dir", d)}`).row();
    });
    const pages = Math.max(1, Math.ceil(newDirs.length / DIRS_PER_PAGE));
    if (pages > 1) {
      if (page > 0) kb.text("« Prev", `np:${page - 1}`);
      kb.text(`page ${page + 1}/${pages}`, "noop");
      if (page < pages - 1) kb.text("Next »", `np:${page + 1}`);
    }
    return kb;
  };

  const usageBar = (pct?: number): string => {
    if (pct === undefined) return "▫️ n/a";
    const filled = Math.round(Math.min(100, pct) / 10);
    return `${"▓".repeat(filled)}${"░".repeat(10 - filled)} ${Math.round(pct)}%`;
  };

  // ---- commands ----
  bot.command("start", async (ctx) => {
    // chatId is pinned once bound (review finding #4): a stray /start in another chat must NOT
    // silently repoint all output/prompts/files there. Moving is explicit via /bindchat.
    if (cfg.chatId && ctx.chat.id !== cfg.chatId)
      return void ctx.reply("👋 The cockpit is already bound to another chat. To move ALL output, prompts, and file payloads to THIS chat, run /bindchat here (asks for confirmation).");
    if (!cfg.chatId) {
      cfg.chatId = ctx.chat.id;
      if (ctx.chat.type === "supergroup" && (ctx.chat as { is_forum?: boolean }).is_forum) cfg.forumMode = true;
      saveConfig(cfg);
    }
    await ctx.reply("👋 Cockpit online. /new to start a session, /sessions to browse, /help for everything.");
  });

  bot.command("bindchat", async (ctx) => {
    if (cfg.chatId === ctx.chat.id) return void ctx.reply("This chat is already the cockpit's home.");
    const isForum = ctx.chat.type === "supergroup" && Boolean((ctx.chat as { is_forum?: boolean }).is_forum);
    const kb = new InlineKeyboard().text("⚠️ Yes — rebind to THIS chat", "bind:yes").row().text("Cancel", "bind:no");
    await ctx.reply(
      `⚠️ <b>Rebind the cockpit to this chat?</b>\nALL session output, permission prompts, and file payloads will move here${isForum ? " (forum mode: one topic per session)" : ""}.\n` +
      `${isForum ? "" : "Prefer a private chat, or a private forum group you control.\n"}` +
      `Currently bound chat id: <code>${cfg.chatId ?? "none"}</code>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.command("help", (ctx) =>
    ctx.reply(
      [
        "<b>Sessions</b>: /new [path] · /sessions · /resume &lt;id&gt; · /use (flat mode) · /stop · /kill",
        "<b>While in a session topic</b>: just type to send input · /model · /mode · /effort · /status · /copy · /plan · /tasks · /files · /file &lt;path&gt;",
        "<b>Watch foreign sessions</b>: /sessions → 👁 Watch · /unwatch",
        "<b>Overview</b>: /usage · /routines · /plans · /groups · /group &lt;name&gt; · /ungroup &lt;name&gt; · /account",
        "<b>Permissions & plans</b> arrive as button prompts automatically.",
      ].join("\n"),
      { parse_mode: "HTML" },
    ),
  );

  bot.command("new", async (ctx) => {
    const arg = ctx.match?.trim();
    if (arg) {
      const [dir, ...rest] = arg.split(/\s+/);
      const abs = dir.startsWith("~") ? dir.replace("~", process.env.HOME ?? "") : dir;
      const created = await startSession(path.resolve(abs), rest.join(" ") || undefined);
      if (!created) await ctx.reply(`Directory not found: ${abs}`);
      return;
    }
    newDirs = await projectDirs();
    newDirsPage = 0;
    awaiting.set(threadKey(ctx), { type: "dir" });
    await ctx.reply(
      `Where should the session run? Tap a project folder (${newDirs.length} with local sessions) or type an absolute path:`,
      { parse_mode: "HTML", reply_markup: newDirsKb(0) },
    );
  });

  // Two-level session browser: a list of PROJECTS (folders) → the sessions inside one.
  // Scales cleanly to 100+ sessions in ONE message that edits in place (no wall of pages).
  const PROJECTS_PER_PAGE = 10;
  interface Project { folder: string; idxs: number[]; recent: number; live: boolean }
  let projects: Project[] = [];
  let projectsPage = 0;
  let curProject = -1;
  let projSessPage = 0;

  const buildProjects = (): void => {
    for (const s of lastList) {
      if (!s.realCwd) s.realCwd = s.cwd;
      // Sidecars usually carry a real title; for the rare untitled one, derive from first prompt.
      if (!s.title && s.file) { const m = sessionMeta(s.file); if (m.firstPrompt) s.title = m.firstPrompt; }
    }
    const by = new Map<string, number[]>();
    lastList.forEach((s, i) => {
      let arr = by.get(s.realCwd!);
      if (!arr) { arr = []; by.set(s.realCwd!, arr); }
      arr.push(i);
    });
    projects = [...by.entries()]
      .map(([folder, idxs]) => ({
        folder, idxs,
        recent: Math.max(...idxs.map((i) => lastList[i].mtime)),
        live: idxs.some((i) => lastList[i].live),
      }))
      .sort((a, b) => b.recent - a.recent); // folders by most-recent activity
  };

  let sessionsTotal = 0;
  const projectsText = (): string => {
    const active = lastList.filter((s) => !s.archived).length;
    const archived = lastList.length - active;
    const shown = sessionsTotal > lastList.length ? `showing ${lastList.length} most-recent of ${sessionsTotal}` : `${lastList.length}`;
    return `<b>Projects</b> — ${shown} sessions across ${projects.length} folders\n` +
      `<i>${active} active${archived ? ` · ${archived} archived 🗄` : ""} · 🟢 = live now. Tap a project.</i>`;
  };

  const projectsKb = (page: number): InlineKeyboard => {
    const kb = new InlineKeyboard();
    const start = page * PROJECTS_PER_PAGE;
    projects.slice(start, start + PROJECTS_PER_PAGE).forEach((p) => {
      kb.text(`${p.live ? "🟢" : "📁"} ${path.basename(p.folder)} · ${p.idxs.length} · ${fmtAgo(p.recent)}`, `proj:${putRef("proj", p.folder)}`).row();
    });
    const pages = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
    if (pages > 1) {
      if (page > 0) kb.text("« Prev", `pp:${page - 1}`);
      kb.text(`page ${page + 1}/${pages}`, "noop");
      if (page < pages - 1) kb.text("Next »", `pp:${page + 1}`);
    }
    return kb;
  };

  const projSessText = (pi: number): string => {
    const p = projects[pi];
    return `<b>${esc(path.basename(p.folder))}</b> — ${p.idxs.length} session${p.idxs.length > 1 ? "s" : ""}\n` +
      `<code>${esc(shortPath(p.folder))}</code>\n<i>🟢 running now · ⚪️ resumable · newest first. Tap one to act.</i>`;
  };

  const projSessKb = (pi: number, page: number): InlineKeyboard => {
    const kb = new InlineKeyboard();
    const p = projects[pi];
    const start = page * SESSIONS_PER_PAGE;
    p.idxs.slice(start, start + SESSIONS_PER_PAGE).forEach((gi) => {
      const s = lastList[gi];
      const name = s.title ?? path.basename(s.realCwd!);
      const mark = s.live ? "🟢" : s.archived ? "🗄" : "⚪️";
      kb.text(`${mark} ${name.slice(0, 28)} · ${fmtAgo(s.mtime)}`, `sl:${putRef("sess", s.sessionId)}:m`).row();
    });
    const pages = Math.max(1, Math.ceil(p.idxs.length / SESSIONS_PER_PAGE));
    if (pages > 1) {
      if (page > 0) kb.text("« Prev", `ps:${putRef("proj", p.folder)}:${page - 1}`);
      kb.text(`page ${page + 1}/${pages}`, "noop");
      if (page < pages - 1) kb.text("Next »", `ps:${putRef("proj", p.folder)}:${page + 1}`);
    }
    kb.text("« All projects", "projs");
    return kb;
  };

  bot.command("sessions", async (ctx) => {
    const res = await listLocalSessions(cfg.accounts, 300);
    lastList = res.sessions;
    sessionsTotal = res.total;
    if (!lastList.length) return void ctx.reply("No local sessions found.");
    // listLocalSessions already sorts live → active → archived, each newest-first; keep that
    // order so within a project the live/active ones sit above archived (don't re-sort here).
    buildProjects();
    projectsPage = 0; curProject = -1; projSessPage = 0;
    await cockpit.say(null, projectsText(), projectsKb(0));
  });

  bot.command("resume", async (ctx) => {
    const id = ctx.match?.trim();
    if (!id) return void ctx.reply("Usage: /resume <session-id or list number>");
    const byNum = /^\d{1,2}$/.test(id) ? lastList[Number(id) - 1] : lastList.find((s) => s.sessionId.startsWith(id));
    if (!byNum) return void ctx.reply("Session not found — run /sessions first or give a session id.");
    await resumeLocal(byNum, false);
  });

  // Mirror the last exchange (their last turn + Claude's last reply) so you can see where
  // a resumed session left off before continuing it.
  async function postTail(rec: SessionRec, file: string): Promise<void> {
    const tail = sessionTail(file);
    if (!tail.lastUser && !tail.lastAssistant) return;
    const parts = ["📖 <b>Where it left off</b>"];
    if (tail.lastUser) parts.push(`👤 <i>${esc(tail.lastUser)}</i>`);
    if (tail.lastAssistant) parts.push(mdToHtml(tail.lastAssistant));
    await cockpit.say(rec, parts.join("\n\n"));
  }

  // A session the bridge itself already runs (has a topic here), if any.
  const bridgeManaged = (sessionId: string): SessionRec | undefined =>
    [...store.sessions.values()].find((r) => r.kind === "managed" && r.sessionId === sessionId && r.status !== "closed");

  // Fresh authoritative lookup by session id — used before any action that MUTATES state
  // (resume / fork / close-on-Mac): a cached list entry's live/pid can be stale, and the
  // close path signals a process (findings #6/#7). Also refreshes the browse cache.
  async function findSessionFresh(sessionId: string): Promise<LocalSession | undefined> {
    try {
      const res = await listLocalSessions(cfg.accounts, 300);
      lastList = res.sessions;
      sessionsTotal = res.total;
      buildProjects();
      return res.sessions.find((s) => s.sessionId === sessionId);
    } catch { return undefined; }
  }

  async function resumeLocal(s: LocalSession, fork: boolean): Promise<void> {
    if (!fork) {
      // If this is one of OUR sessions, it already has a topic — reuse it (it being "live"
      // just means our own process; never treat it as a foreign session to close).
      const existing = bridgeManaged(s.sessionId);
      if (existing) {
        activeKey = existing.key;
        if (cockpit.live.get(existing.key)) {
          await cockpit.say(existing, "▶️ This is already open in its own topic here — go there and type.");
          return;
        }
        await cockpit.spawn(existing, { resume: s.sessionId });
        await cockpit.say(existing, "▶️ Resumed in its existing topic — type to continue.");
        await postTail(existing, s.file);
        return;
      }
    }
    // Not ours, and live on the Mac → can't resume without interleaving; caller offers Close/Fork.
    if (s.live && !fork) {
      await cockpit.say(null, "That session is live on the Mac — resuming here would interleave two writers. Use <b>Close on Mac & continue</b> or <b>Fork</b>.");
      return;
    }
    const cwd = sessionCwd(s.file) ?? s.cwd;
    const name = s.title ?? s.sessionId.slice(0, 8);
    // The session's original folder must exist to resume (that's where its transcript lives).
    // If it was deleted/renamed since, offer to recreate it — history is in the transcript, not the folder.
    if (!fs.existsSync(cwd)) {
      const kb = new InlineKeyboard()
        .text("📁 Recreate folder & resume", `mk:${putRef("sess", s.sessionId)}:${Number(fork)}`).row()
        .text("Cancel", "sl:back");
      await cockpit.say(null,
        `⚠️ This session's folder no longer exists:\n<code>${esc(cwd)}</code>\n` +
        "It was moved or deleted since the session ran. I can recreate the (empty) folder and resume — the full conversation is preserved in the transcript; only the old files in that folder are gone.",
        kb);
      return;
    }
    const rec = await startSession(cwd, undefined, {
      sessionId: s.sessionId,
      account: s.account,
      title: `${name} · ${path.basename(cwd)}`.slice(0, 96),
    } as Partial<SessionRec>);
    if (rec) {
      await cockpit.say(rec, fork ? "🔀 Forked from the live session — this is a separate branch." : "▶️ Resumed. Type to continue the conversation.");
      await postTail(rec, s.file);
    } else await cockpit.say(null, `⚠️ Couldn't start the session in <code>${esc(cwd)}</code>. Try /new instead.`);
  }

  // ---- Away-mode foreign-session permission relay (opt-in; default off) ----
  ensureForeignState();
  // "Always allow" grants are scoped to the EXACT call — cwd + tool + a hash of the exact input
  // (review finding #8): approving one benign Bash must never green-light every future Bash in
  // that directory. Keys are canonical (object keys sorted) so an identical re-ask matches.
  const stableStringify = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  };
  const foreignKey = (cwd: string, tool: string, input: Record<string, unknown>): string =>
    `${cwd}::${tool}::${createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 16)}`;
  const foreignAlways = new Set<string>(); // foreignKey() values the owner said "always allow" to
  let pendingForeignRevise: string | null = null; // foreignApprovals id awaiting revision feedback
  startPermServer(foreignState().port, foreignState().token, async (req) => {
    if (bridgeManaged(req.sessionId)) return { decision: "ask" as const }; // our own session — canUseTool handles it
    if (foreignAlways.has(foreignKey(req.cwd, req.tool, req.input))) return { decision: "allow" as const };
    return cockpit.askForeign(randomBytes(4).toString("hex"), req.tool, req.cwd, req.input, foreignState().waitSeconds * 1000);
  });

  bot.command("foreign", async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();
    const st = foreignState();
    if (arg?.startsWith("on")) {
      const mins = Number(arg.split(/\s+/)[1]);
      const idle = Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60) : st.idleSeconds;
      const s = enableForeign(idle);
      const thresh = s.idleSeconds < 60 ? `${s.idleSeconds}s` : `${Math.round(s.idleSeconds / 60)} min`;
      return void ctx.reply(
        `✅ Away-mode <b>ON</b>. When you've been away from the Mac for <b>${thresh}</b>, permission prompts from desktop/terminal sessions come here with Allow/Deny. No answer in ~2 min → the prompt waits on the Mac. <code>/foreign off</code> to stop.`,
        { parse_mode: "HTML" });
    }
    if (arg === "off") {
      disableForeign();
      foreignAlways.clear(); // standing grants must not survive an off→on cycle
      return void ctx.reply("🚫 Away-mode OFF. The global hook is removed — zero effect on your desktop sessions. (Any \"always allow\" grants were cleared.)");
    }
    await ctx.reply(
      `<b>Away-mode</b>: ${st.enabled ? "🟢 ON" : "⚪️ off"}\nIdle threshold: <b>${Math.round(st.idleSeconds / 60)} min</b>\n\n` +
      "Forwards permission prompts from sessions you started <i>outside</i> Telegram (desktop app / terminal) to your phone — but only while you're away from the Mac, and only for approval-worthy tools. Fails safe to the normal desktop prompt.\n\n" +
      "<code>/foreign on</code> · <code>/foreign on 5</code> (idle minutes) · <code>/foreign off</code>",
      { parse_mode: "HTML" });
  });

  bot.command("use", async (ctx) => {
    const open = [...store.sessions.values()].filter((s) => s.kind === "managed" && s.status !== "closed");
    if (!open.length) return void ctx.reply("No open sessions. /new to start one.");
    const kb = new InlineKeyboard();
    open.slice(0, 10).forEach((s) => kb.text(`${s.status === "running" ? "🟢" : "💤"} ${s.title ?? s.cwd}`, `use:${s.key}`).row());
    await ctx.reply("Active session for this chat:", { reply_markup: kb });
  });

  bot.command("stop", async (ctx) => {
    const rec = recOf(ctx);
    const sess = rec && cockpit.live.get(rec.key);
    if (!sess) return void ctx.reply("No live managed session here.");
    await sess.interrupt();
    await ctx.reply("⏹ Interrupted.");
  });

  bot.command("kill", async (ctx) => {
    const rec = recOf(ctx);
    const sess = rec && cockpit.live.get(rec.key);
    if (!sess) return void ctx.reply("No live managed session here.");
    sess.kill();
    if (rec) cockpit.live.delete(rec.key); // don't let the dead session linger in `live` (finding #4)
    store.flushSessions();
    await ctx.reply("💀 Killed.");
  });

  bot.command("mode", async (ctx) => {
    const rec = recOf(ctx);
    if (!rec) return void ctx.reply("No session here.");
    const kb = new InlineKeyboard();
    MODES.forEach((m) => kb.text(m.id === rec.mode ? `✓ ${m.label}` : m.label, `mo:${m.id}`).row());
    const hints = MODES.map((m) => `${m.id === rec.mode ? "✓" : "·"} <b>${m.label}</b> — <i>${m.hint}</i>`).join("\n");
    await ctx.reply(`<b>Permission mode</b> — current: <b>${modeLabel(rec.mode)}</b>\n\n${hints}`, { parse_mode: "HTML", reply_markup: kb });
  });

  bot.command("effort", async (ctx) => {
    const rec = recOf(ctx);
    if (!rec) return void ctx.reply("No session here.");
    const kb = new InlineKeyboard();
    EFFORTS.forEach((e) => kb.text(e.id === rec.effort ? `✓ ${e.label}` : e.label, `ef:${e.id}`).row());
    const hints = EFFORTS.map((e) => `${e.id === rec.effort ? "✓" : "·"} <b>${e.label}</b> — <i>${e.hint}</i>`).join("\n");
    await ctx.reply(`<b>Effort</b> (Smarter → Faster) — current: <b>${effortLabel(rec.effort)}</b>\n\n${hints}`, { parse_mode: "HTML", reply_markup: kb });
  });

  bot.command("model", async (ctx) => {
    const rec = recOf(ctx);
    if (!rec) return void ctx.reply("No session here.");
    const sess = cockpit.live.get(rec.key);
    let models = sess ? await sess.models() : [];
    if (models.length) cachedModels = models;
    else models = cachedModels;
    if (!models.length) return void ctx.reply("Model list not loaded yet — send one message to any session first, then retry.");
    const isCurrent = (m: { id: string; resolved?: string }): boolean =>
      m.id === rec.model || (!!m.resolved && m.resolved === rec.model);
    const kb = new InlineKeyboard();
    models.slice(0, 12).forEach((m) => {
      kb.text(`${isCurrent(m) ? "✓ " : ""}${modelVersion(m)}`, `md:${rec.key}:${putRef("model", m.id)}`).row();
    });
    modelChoices.set(rec.key, models);
    const lines = models.map((m) => `${isCurrent(m) ? "✓" : "·"} <b>${esc(m.label)}</b> — <i>${esc(m.description || m.resolved || "")}</i>`);
    await ctx.reply(`<b>Model</b> — current: <b>${esc(rec.model ?? "Default")}</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML", reply_markup: kb });
  });
  const modelChoices = new Map<string, Array<{ id: string; label: string; description: string; resolved?: string }>>();
  let cachedModels: Array<{ id: string; label: string; description: string; resolved?: string }> = [];

  // Full details panel — works in any topic (managed, detached, or watch sessions).
  const infoPanel = async (ctx: Context): Promise<void> => {
    const rec = recOf(ctx);
    if (!rec) return void ctx.reply("No session bound here. /sessions to pick one, /new to start.");
    const sess = cockpit.live.get(rec.key);
    const acct = cockpit.account(rec.account);
    const enc = rec.cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projDir = path.join(configDirOf(acct), "projects", enc);

    const dot = rec.status === "running" ? "🟢" : rec.status === "watching" ? "👁" : rec.status === "idle" ? "🟡" : "⚪️";
    const lines: string[] = [
      `📟 <b>${esc(rec.title ?? path.basename(rec.cwd))}</b>`,
      `<i>${dot} ${rec.status} · ${rec.kind} · started ${fmtAgo(rec.createdAt)} · last activity ${fmtAgo(rec.lastActivityAt)}</i>`,
    ];
    const pend = [...cockpit.approvals.values()].filter((a) => a.sessionKey === rec.key).length;
    if (pend) lines.push(`⚠️ <b>${pend} pending permission prompt${pend > 1 ? "s" : ""}</b> — scroll up to answer`);
    const taskLines = rec.sessionId ? sessionTasks(rec.sessionId, projDir) : [];
    if (taskLines.length) lines.push(`⚙️ ${taskLines.length} background item${taskLines.length > 1 ? "s" : ""} (/tasks)`);
    if (sess?.lastPlan) lines.push("📋 plan available (/plan)");

    lines.push("", "<b>Usage</b>");
    let tModel: string | undefined;
    let ctxLine = "▫️ context n/a";
    if (sess) {
      const u = await sess.contextUsage();
      if (u) ctxLine = `${usageBar(u.percentage)} context · ${fmtTokens(u.totalTokens)}/${fmtTokens(u.maxTokens)}`;
    } else if (rec.sessionId) {
      const t = transcriptContextPct(path.join(projDir, `${rec.sessionId}.jsonl`));
      if (t) { ctxLine = `${usageBar(t.pct)} context <i>(from transcript)</i>`; tModel = t.model; }
    }
    lines.push(ctxLine);
    const u = await accountUsage(acct);
    const wline = (w: { pct?: number; resetsAt?: number; source: string; at: number } | undefined, name: string): string | null =>
      w?.pct === undefined
        ? null
        : `${usageBar(w.pct)} ${name}${w.resetsAt ? ` · ${fmtReset(w.resetsAt)}` : ""} <i>(${w.source}, ${fmtAgo(w.at)})</i>`;
    const fiveLine = wline(u.fiveHour, "5-hour");
    const weekLine = wline(u.sevenDay, "weekly");
    if (fiveLine) lines.push(fiveLine);
    if (weekLine) lines.push(weekLine);
    if (!fiveLine && !weekLine) lines.push(u.needsReauth ? "▫️ limits n/a — reauth needed (log in again on the Mac)" : "▫️ limits n/a — run a turn on this account first");

    lines.push("", "<b>Setup</b>");
    lines.push(`model <code>${esc(rec.model ?? tModel ?? "default")}</code>`);
    lines.push(`mode <b>${modeLabel(rec.mode)}</b> · effort <b>${effortLabel(rec.effort)}</b>`);
    let acctLine = `account <b>${esc(acct.name)}</b>`;
    if (sess) {
      const who = await sess.loggedInAs();
      if (who?.email && who.email !== acct.name) acctLine += ` · ${esc(who.email)}`;
      if (who?.subscriptionType) acctLine += ` (${esc(who.subscriptionType)})`;
    }
    lines.push(acctLine);

    lines.push("", "<b>Session</b>");
    lines.push(`<code>${esc(rec.cwd)}</code>`);
    lines.push(rec.sessionId ? `<code>${esc(rec.sessionId)}</code>` : "<i>session id pending first reply</i>");
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  };
  bot.command("info", infoPanel);
  bot.command("status", infoPanel);

  const healthPanel = async (ctx: Context): Promise<void> => {
    const lines = ["<b>🩺 Health check</b>"];
    try {
      const { stdout } = await execFileP("claude", ["--version"], { timeout: 5000 });
      lines.push(`✅ Claude CLI reachable — <code>${esc(stdout.trim())}</code>`);
    } catch {
      lines.push("❌ Claude CLI not reachable on PATH — new sessions can't start.");
    }
    const st = foreignState();
    lines.push(st.enabled
      ? `✅ Away-mode ON — perm server on 127.0.0.1:${st.port} (idle ≥ ${Math.round(st.idleSeconds / 60)}m)`
      : "▫️ Away-mode off — perm server idle (/foreign on to enable).");
    const connected = cfg.accounts.filter(accountConnected).map((a) => a.name);
    lines.push(connected.length ? `✅ Accounts logged in — <code>${esc(connected.join(", "))}</code>` : "⚠️ No accounts logged in (see /account).");
    lines.push(`✅ Paired — owner ${cfg.ownerId ? "set" : "unset"}, chat ${cfg.chatId ? "bound" : "unbound"}, ${cfg.forumMode ? "forum" : "flat"} mode`);
    lines.push(`✅ Live managed sessions: ${cockpit.live.size}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  };
  bot.command("health", healthPanel);
  bot.command("doctor", healthPanel);

  bot.command("usage", async (ctx) => {
    // Dynamic list: only accounts actually logged in right now. Log one in later and it
    // appears here; log one out / remove it and it drops off — no static roster.
    const connected = cfg.accounts.filter(accountConnected);
    const dormant = cfg.accounts.filter((a) => !accountConnected(a));
    const lines: string[] = ["<b>Usage by account</b>"];
    for (const a of connected) {
      const u = await accountUsage(a);
      lines.push(`\n<b>${esc(a.name)}</b>${a.name === cfg.activeAccount ? " (active)" : ""}`);
      if (u.fiveHour) lines.push(`5h  ${usageBar(u.fiveHour.pct)} ${fmtReset(u.fiveHour.resetsAt)} <i>(${u.fiveHour.source}, ${fmtAgo(u.fiveHour.at)})</i>`);
      if (u.sevenDay) lines.push(`week ${usageBar(u.sevenDay.pct)} ${fmtReset(u.sevenDay.resetsAt)} <i>(${u.sevenDay.source}, ${fmtAgo(u.sevenDay.at)})</i>`);
      if (!u.fiveHour && !u.sevenDay)
        lines.push(u.needsReauth
          ? "<i>n/a — reauth needed: its token has expired. Log in again on the Mac (see /account).</i>"
          : "<i>logged in, but no reading yet — its token is idle. Use it once (/new here, or move a session to it) and it'll show.</i>");
    }
    if (!connected.length) lines.push("\n<i>No accounts connected. Log one in on the Mac (see /account).</i>");
    if (dormant.length) lines.push(`\n<i>Not connected: ${dormant.map((a) => esc(a.name)).join(", ")} — run its login on the Mac to include it.</i>`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("routines", async (ctx) => {
    const rs = listRoutines();
    if (!rs.length) return void ctx.reply("No local scheduled tasks found.");
    const lines = rs.map((r) =>
      `${r.enabled === false ? "⏸" : "⏰"} <b>${esc(r.name)}</b>\n      <i>${esc(r.schedule ?? "?")}${r.lastRunAt ? ` · last ${esc(String(r.lastRunAt).slice(0, 16))}` : ""}${r.cwd ? ` · ${esc(path.basename(r.cwd))}` : ""}</i>`,
    );
    await cockpit.say(null, `<b>Local routines</b> (run via the desktop app)\n\n${lines.join("\n")}`);
  });

  bot.command("plans", async (ctx) => {
    const ps = listPlans();
    if (!ps.length) return void ctx.reply("No plan files.");
    const kb = new InlineKeyboard();
    ps.forEach((p) => kb.text(p.name.slice(0, 50), `pf:${putRef("plan", p.file)}`).row());
    await ctx.reply("Recent plan files (tap to receive as file):", { reply_markup: kb });
  });

  bot.command("plan", async (ctx) => {
    const rec = recOf(ctx);
    const sess = rec && cockpit.live.get(rec.key);
    if (sess?.lastPlan) return void cockpit.say(rec!, `📋 <b>Current plan</b>\n\n${esc(sess.lastPlan).slice(0, 12000)}`);
    await ctx.reply("No plan in this session. /plans lists saved plan files.");
  });

  bot.command("tasks", async (ctx) => {
    const rec = recOf(ctx);
    if (!rec?.sessionId) return void ctx.reply("No session here (or it has no id yet).");
    const acct = cockpit.account(rec.account);
    const enc = rec.cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const lines = sessionTasks(rec.sessionId, path.join(configDirOf(acct), "projects", enc));
    await ctx.reply(lines.length ? lines.map(esc).join("\n") : "No background tasks / todos for this session.", { parse_mode: "HTML" });
  });

  bot.command("files", async (ctx) => {
    const rec = recOf(ctx);
    if (!rec) return void ctx.reply("No session here.");
    try {
      const { stdout: status } = await execFileP("git", ["-C", rec.cwd, "status", "--short"], { timeout: 10_000 });
      const { stdout: diff } = await execFileP("git", ["-C", rec.cwd, "diff", "--stat"], { timeout: 10_000 });
      const body = `${status || "(clean)"}\n\n${diff}`.trim();
      await cockpit.say(rec, `📁 <b>git status</b> in <code>${esc(rec.cwd)}</code>\n<pre><code>${esc(body.slice(0, 3500))}</code></pre>`);
    } catch {
      await ctx.reply("Not a git repo (or git failed). Use /file <path> to fetch a specific file.");
    }
  });

  bot.command("file", async (ctx) => {
    // Security: /file streams a file straight to Telegram, so it must be tightly confined —
    // otherwise `/file /etc/passwd` or `/file ../../.ssh/id_rsa` would exfiltrate anything.
    // Rules: a session (with a working directory) must be bound here; the arg is relative to
    // that session's cwd; the realpath must stay inside the cwd (blocks `..` and symlink
    // escapes); dotfiles and known secret/key files are refused; and there is a hard size cap.
    const rec = recOf(ctx);
    if (!rec?.cwd)
      return void ctx.reply("No session bound here. /file sends a file from the bound session's working directory — open a session topic first.");
    const arg = ctx.match?.trim();
    if (!arg) return void ctx.reply("Usage: /file <path> (relative to the session's working directory)");
    if (path.isAbsolute(arg))
      return void ctx.reply("⛔ Absolute paths aren't allowed. Give a path relative to the session directory.");
    let cwdReal: string, real: string, st: fs.Stats;
    try {
      cwdReal = fs.realpathSync(rec.cwd);
      real = fs.realpathSync(path.resolve(cwdReal, arg));
    } catch {
      return void ctx.reply("No such file in this session's directory.");
    }
    if (real !== cwdReal && !real.startsWith(cwdReal + path.sep))
      return void ctx.reply("⛔ That path resolves outside the session directory — refused.");
    try { st = fs.statSync(real); } catch { return void ctx.reply("Couldn't read that file."); }
    if (!st.isFile()) return void ctx.reply("That's not a regular file.");
    const relSegs = path.relative(cwdReal, real).split(path.sep);
    if (relSegs.some((s) => s.startsWith(".")))
      return void ctx.reply("⛔ Dotfiles (e.g. .env, .ssh, .git) can't be sent — they commonly hold secrets.");
    const base = path.basename(real);
    if (/(^id_(rsa|dsa|ecdsa|ed25519))|(\.(pem|key|p12|pfx|keystore|crt)$)|(credentials)|(secret)/i.test(base))
      return void ctx.reply("⛔ That looks like a key/secret file — refused.");
    const MAX_BYTES = 20 * 1024 * 1024;
    if (st.size > MAX_BYTES)
      return void ctx.reply(`File too large (${(st.size / 1048576).toFixed(1)} MB > 20 MB cap).`);
    try {
      await ctx.replyWithDocument(new InputFile(real), rec.topicId ? { message_thread_id: rec.topicId } : {});
    } catch (e) {
      await ctx.reply(`Couldn't send: ${e instanceof Error ? e.message : e}`);
    }
  });

  bot.command("copy", async (ctx) => {
    const rec = recOf(ctx);
    const sess = rec && cockpit.live.get(rec.key);
    if (!sess?.lastFinalText) return void ctx.reply("No output to copy yet.");
    for (const piece of sess.lastFinalText.match(/[\s\S]{1,3500}/g) ?? []) {
      await cockpit.say(rec!, `<pre><code>${esc(piece)}</code></pre>`);
    }
  });

  bot.command("groups", async (ctx) => {
    const lines: string[] = ["<b>Bridge groups</b> (managed here)"];
    const entries = Object.entries(store.groups);
    if (!entries.length) lines.push("<i>none — /group &lt;name&gt; adds the current session to a group</i>");
    for (const [name, g] of entries) {
      const members = g.sessions.map((k) => store.sessions.get(k)?.title ?? k).join(", ");
      lines.push(`📁 <b>${esc(name)}</b>: ${esc(members || "(empty)")}`);
    }
    const desktop = desktopGroupNames();
    if (desktop.length) lines.push(`\n<b>Desktop groups</b> <i>(read-only, from last sync snapshot — approximate)</i>\n${desktop.map((n) => `· ${esc(n)}`).join("\n")}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("group", async (ctx) => {
    const rec = recOf(ctx);
    const name = ctx.match?.trim();
    if (!rec || !name) return void ctx.reply("Usage (inside a session topic): /group <name>");
    addToGroup(store, name, rec.key);
    await ctx.reply(`Added to group 📁 ${name}`);
  });

  bot.command("ungroup", async (ctx) => {
    const rec = recOf(ctx);
    const name = ctx.match?.trim();
    if (!rec || !name) return void ctx.reply("Usage: /ungroup <name>");
    removeFromGroup(store, name, rec.key);
    await ctx.reply(`Removed from 📁 ${name}`);
  });

  bot.command("account", async (ctx) => {
    const arg = ctx.match?.trim();
    if (arg?.startsWith("add ")) {
      const [, name, dir] = arg.split(/\s+/);
      if (!name) return void ctx.reply("Usage: /account add <name> [configDir]");
      const configDir = dir ?? `${process.env.HOME}/.claude-${name}`;
      cfg.accounts.push({ name, configDir });
      saveConfig(cfg);
      await ctx.reply(
        `Account <b>${esc(name)}</b> added.\nOne-time setup on the Mac:\n<pre><code>mkdir -p ${esc(configDir)}\nCLAUDE_CONFIG_DIR=${esc(configDir)} claude auth login</code></pre>\n⚠️ The path string must stay exactly <code>${esc(configDir)}</code> (the keychain entry is keyed on it).`,
        { parse_mode: "HTML" },
      );
      return;
    }
    // Inside a session topic → switch THIS session's account (moves history to the
    // other pool). In General / no topic → set the default for NEW sessions.
    const tid = ctx.message?.message_thread_id;
    const rec = cfg.forumMode ? (tid ? store.byTopic(tid) : undefined) : (activeKey ? store.sessions.get(activeKey) : undefined);
    if (rec && rec.kind === "managed") {
      const kb = new InlineKeyboard();
      cfg.accounts.forEach((a, i) => kb.text(a.name === rec.account ? `✓ ${a.name}` : `🔁 ${a.name}`, `sw:${rec.key}:${i}`).row());
      await ctx.reply(
        `<b>Account for THIS session</b> — current: <b>${esc(rec.account)}</b>\nSwitching moves the conversation (full history) onto that account's limit pool.\n<i>To change the default for new sessions instead, run /account in General.</i>`,
        { parse_mode: "HTML", reply_markup: kb },
      );
      return;
    }
    const kb = new InlineKeyboard();
    cfg.accounts.forEach((a, i) => kb.text(a.name === cfg.activeAccount ? `• ${a.name}` : a.name, `acc:${i}`).row());
    await ctx.reply("Account for NEW sessions:\n<i>run /account inside a session topic to switch that session · /account add &lt;name&gt; to onboard another</i>", { parse_mode: "HTML", reply_markup: kb });
  });

  bot.command("unwatch", async (ctx) => {
    const rec = recOf(ctx);
    if (!rec || rec.kind !== "watch") return void ctx.reply("This isn't a watch topic.");
    cockpit.unwatch(rec);
    await ctx.reply("👁 stopped watching.");
  });

  // ---- callbacks ----
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const done = (t?: string): Promise<unknown> => ctx.answerCallbackQuery(t ? { text: t } : undefined).catch(() => undefined);
    const [head, ...rest] = data.split(":");

    if (head === "bind") {
      if (rest[0] === "yes") {
        const chat = ctx.callbackQuery.message?.chat;
        if (!chat) return void done("Couldn't identify this chat.");
        cfg.chatId = chat.id;
        cfg.forumMode = chat.type === "supergroup" && Boolean((chat as { is_forum?: boolean }).is_forum);
        saveConfig(cfg);
        await ctx.editMessageText(`✅ Cockpit rebound to this chat (<code>${chat.id}</code>)${cfg.forumMode ? " — forum mode" : ""}.`, { parse_mode: "HTML" }).catch(() => undefined);
      } else {
        await ctx.editMessageText("Cancelled — binding unchanged.").catch(() => undefined);
      }
      return void done();
    }

    if (head === "p" || head === "pl" || head === "q") {
      const [aid, verb] = rest;
      const a = cockpit.approvals.get(aid);
      if (!a) { qState.delete(aid); return void done("Expired."); }
      const sess = cockpit.live.get(a.sessionKey);
      const rec = sess?.rec ?? null;
      const editPrompt = async (verdict: string): Promise<void> => {
        if (a.messageId && cfg.chatId) {
          await bot.api.editMessageReplyMarkup(cfg.chatId, a.messageId).catch(() => undefined);
          await bot.api.sendMessage(cfg.chatId, verdict, { parse_mode: "HTML", ...(rec ? cockpit.threadOpts(rec) : {}) }).catch(() => undefined);
        }
      };
      if (head === "p") {
        if (verb === "a") { a.resolve({ behavior: "allow", updatedInput: a.input }); cockpit.approvals.delete(aid); await editPrompt("✅ allowed once"); }
        else if (verb === "d") { a.resolve({ behavior: "deny", message: "Denied by the owner from Telegram." }); cockpit.approvals.delete(aid); await editPrompt("❌ denied"); }
        else if (verb === "w") {
          const kb = new InlineKeyboard()
            .text("This session", `p:${aid}:ws`).row()
            .text("This project", `p:${aid}:wl`).row()
            .text("Everywhere (user settings)", `p:${aid}:wu`);
          await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => undefined);
        } else if (verb === "ws" || verb === "wl" || verb === "wu") {
          const destination = verb === "ws" ? "session" : verb === "wl" ? "localSettings" : "userSettings";
          const updates = (a.suggestions?.length
            ? a.suggestions.map((s) => ({ ...s, destination }))
            : [{ type: "addRules", rules: [{ toolName: a.toolName }], behavior: "allow", destination }]) as never;
          a.resolve({ behavior: "allow", updatedInput: a.input, updatedPermissions: updates });
          cockpit.approvals.delete(aid);
          await editPrompt(`♾ always allowed (<i>${destination}</i>)`);
        }
        return void done();
      }
      if (head === "pl") {
        if (verb === "a" || verb === "m") {
          a.resolve({ behavior: "allow", updatedInput: a.input });
          cockpit.approvals.delete(aid);
          const mode = verb === "a" ? "acceptEdits" : "default";
          setTimeout(() => void sess?.setMode(mode).then(() => store.flushSessions()).catch(() => undefined), 500);
          await editPrompt(`✅ plan approved → mode <b>${mode}</b>`);
        } else if (verb === "r") {
          if (rec) awaiting.set(`${cfg.chatId}:${rec.topicId ?? 0}`, { type: "planFeedback", aid });
          await editPrompt("✏️ Send your revision feedback as a normal message.");
        } else if (verb === "x") {
          a.resolve({ behavior: "deny", message: "Plan rejected by the user. Stop and wait for new instructions.", interrupt: true });
          cockpit.approvals.delete(aid);
          await editPrompt("❌ plan rejected");
        }
        return void done();
      }
      if (head === "q") {
        // q:<aid>:<qIdx>:<optIdx> toggles/answers · q:<aid>:<qIdx>:o = free text · q:<aid>:submit.
        // A single single-select question answers on first tap; anything else collects then submits.
        const questions = (a.input.questions as Array<Record<string, unknown>> | undefined) ?? [];
        const instant = questions.length === 1 && !questions[0]?.multiSelect;
        const sel = qState.get(aid) ?? new Map<number, Set<number> | string>();
        qState.set(aid, sel);
        const finish = async (answers: Record<string, string>): Promise<void> => {
          a.resolve({ behavior: "allow", updatedInput: { ...a.input, answers } });
          cockpit.approvals.delete(aid);
          qState.delete(aid);
          await editPrompt(`💬 answered: <b>${esc(Object.values(answers).join(" · ")).slice(0, 300)}</b>`);
        };
        if (verb === "submit") {
          const answers: Record<string, string> = {};
          for (let qi = 0; qi < questions.length; qi++) {
            const picked = sel.get(qi);
            const opts = (questions[qi].options as Array<{ label: string }> | undefined) ?? [];
            if (typeof picked === "string") answers[String(questions[qi].question ?? `q${qi + 1}`)] = picked;
            else if (picked instanceof Set && picked.size)
              answers[String(questions[qi].question ?? `q${qi + 1}`)] = [...picked].sort((x, y) => x - y).map((i) => opts[i]?.label ?? String(i)).join(", ");
            else return void done(`Answer all ${questions.length} question${questions.length > 1 ? "s" : ""} first (question ${qi + 1} is empty).`);
          }
          await finish(answers);
          return void done();
        }
        const qi = Number(verb);
        const q = questions[qi];
        if (!q) return void done("Expired.");
        const third = rest[2];
        if (third === "o") {
          if (rec) awaiting.set(`${cfg.chatId}:${rec.topicId ?? 0}`, { type: "questionOther", aid, qIdx: qi });
          if (instant) await editPrompt("✍️ Send your answer as a normal message.");
          else await cockpit.say(rec, `✍️ Send your answer to question ${qi + 1} as a normal message.`);
          return void done();
        }
        const oi = Number(third);
        const opts = (q.options as Array<{ label: string }> | undefined) ?? [];
        if (!opts[oi]) return void done("Expired.");
        if (instant) { await finish({ [String(q.question ?? "q")]: opts[oi].label }); return void done(); }
        const cur = sel.get(qi);
        if (q.multiSelect) {
          const set = cur instanceof Set ? cur : new Set<number>();
          if (set.has(oi)) set.delete(oi); else set.add(oi);
          sel.set(qi, set);
        } else {
          sel.set(qi, new Set([oi])); // single-select within a multi-question ask: replace
        }
        if (a.messageId && cfg.chatId)
          await bot.api.editMessageReplyMarkup(cfg.chatId, a.messageId, { reply_markup: cockpit.questionKb(a, sel) }).catch(() => undefined);
        return void done();
      }
    }

    if (head === "np") {
      newDirsPage = Math.max(0, Math.min(Number(rest[0]), Math.ceil(newDirs.length / DIRS_PER_PAGE) - 1));
      await ctx.editMessageReplyMarkup({ reply_markup: newDirsKb(newDirsPage) }).catch(() => undefined);
      return void done();
    }
    if (head === "dir") {
      const dir = getRef("dir", rest[0]);
      if (!dir) { await ctx.editMessageText("That picker expired — run /new again.").catch(() => undefined); return void done(); }
      awaiting.delete(threadKey(ctx));
      await ctx.editMessageText(`Directory → <code>${esc(dir)}</code> ✅`, { parse_mode: "HTML" }).catch(() => undefined);
      await done();
      await startSession(dir);
      return;
    }
    if (head === "noop") return void done();
    if (head === "fp") { // foreign-session permission/plan verdict
      const fa = cockpit.foreignApprovals.get(rest[0]);
      if (!fa) return void done("expired");
      const verb = rest[1];
      if (verb === "a") { fa.resolve({ decision: "allow" }); await ctx.editMessageText("✅ allowed once (foreign session)").catch(() => undefined); }
      else if (verb === "d") { fa.resolve({ decision: "deny", reason: "Denied by owner from phone." }); await ctx.editMessageText("❌ denied (foreign session)").catch(() => undefined); }
      else if (verb === "w") {
        foreignAlways.add(foreignKey(fa.cwd, fa.tool, fa.input));
        fa.resolve({ decision: "allow" });
        await ctx.editMessageText(`♾ Always allowing this <b>exact ${esc(fa.tool)} call</b> in this project while away (cleared on /foreign off or restart).`, { parse_mode: "HTML" }).catch(() => undefined);
      }
      else if (verb === "pa") { fa.resolve({ decision: "allow" }); await ctx.editMessageText("✅ plan approved (foreign session)").catch(() => undefined); }
      else if (verb === "px") { fa.resolve({ decision: "deny", reason: "Plan rejected by owner from phone. Stop and wait for new instructions." }); await ctx.editMessageText("❌ plan rejected (foreign session)").catch(() => undefined); }
      else if (verb === "pv") {
        pendingForeignRevise = rest[0];
        await ctx.editMessageText("✏️ Send your revision feedback as a normal message.").catch(() => undefined);
      }
      return void done();
    }
    if (head === "mk") { // recreate a missing session folder, then resume/fork
      const sid = getRef("sess", rest[0]);
      const s = sid ? await findSessionFresh(sid) : undefined;
      if (!s) return void done("Expired — run /sessions again.");
      const cwd = sessionCwd(s.file) ?? s.cwd;
      try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* report below */ }
      await ctx.editMessageText(fs.existsSync(cwd) ? `📁 Recreated <code>${esc(cwd)}</code> — resuming…` : `⚠️ Couldn't create <code>${esc(cwd)}</code>`, { parse_mode: "HTML" }).catch(() => undefined);
      await done();
      if (fs.existsSync(cwd)) await resumeLocal(s, rest[1] === "1");
      return;
    }
    if (head === "pp") { // projects list pagination
      projectsPage = Math.max(0, Math.min(Number(rest[0]), Math.ceil(projects.length / PROJECTS_PER_PAGE) - 1));
      await ctx.editMessageText(projectsText(), { parse_mode: "HTML", reply_markup: projectsKb(projectsPage) }).catch(() => undefined);
      return void done();
    }
    if (head === "projs") { // back to the projects list
      await ctx.editMessageText(projectsText(), { parse_mode: "HTML", reply_markup: projectsKb(projectsPage) }).catch(() => undefined);
      return void done();
    }
    if (head === "proj") { // open one project's sessions (ref → folder path → current index)
      const folder = getRef("proj", rest[0]);
      const pi = folder ? projects.findIndex((p) => p.folder === folder) : -1;
      if (pi < 0) return void done("Run /sessions again.");
      curProject = pi; projSessPage = 0;
      await ctx.editMessageText(projSessText(pi), { parse_mode: "HTML", reply_markup: projSessKb(pi, 0) }).catch(() => undefined);
      return void done();
    }
    if (head === "ps") { // sessions pagination within a project
      const folder = getRef("proj", rest[0]);
      const pi = folder ? projects.findIndex((p) => p.folder === folder) : -1;
      if (pi < 0) return void done("Run /sessions again.");
      projSessPage = Number(rest[1]);
      await ctx.editMessageText(projSessText(pi), { parse_mode: "HTML", reply_markup: projSessKb(pi, projSessPage) }).catch(() => undefined);
      return void done();
    }
    if (head === "sl") {
      const restoreList = async (): Promise<void> => {
        if (curProject >= 0 && projects[curProject])
          await ctx.editMessageText(projSessText(curProject), { parse_mode: "HTML", reply_markup: projSessKb(curProject, projSessPage) }).catch(() => undefined);
      };
      if (rest[0] === "back") { await restoreList(); return void done(); }
      const sid = getRef("sess", rest[0]);
      if (!sid) return void done("These buttons expired — run /sessions again.");
      // Menu/details/mirror may use the cached entry (identity-matched by session id, so a
      // rebuilt list can't swap the target). Mutating actions re-resolve against fresh state below.
      let s = lastList.find((x) => x.sessionId === sid);
      if (rest[1] === "m") {
        if (!s) return void done("Run /sessions again.");
        // Update the message TEXT to the picked session, and show its actions.
        const mark = s.live ? "🟢 live now" : s.archived ? "🗄 archived" : "⚪️ resumable";
        const txt = `<b>${esc(s.title ?? path.basename(s.realCwd ?? s.cwd))}</b>\n` +
          `<code>${esc(shortPath(s.realCwd ?? s.cwd))}</code>\n` +
          `${mark} · <i>${fmtAgo(s.mtime)}</i>\n\nChoose an action:`;
        const kb = new InlineKeyboard();
        if (bridgeManaged(s.sessionId)) {
          kb.text("▶️ Go to its topic (open here)", `sl:${rest[0]}:r`).row(); // our own live session
        } else if (s.live) {
          kb.text("🛑 Close on Mac & continue here", `sl:${rest[0]}:c`).row();
          kb.text("🔀 Fork instead (leave it running)", `sl:${rest[0]}:f`).row();
        } else {
          kb.text("▶️ Continue here", `sl:${rest[0]}:r`).row();
        }
        kb.text("👁 Mirror its output here", `sl:${rest[0]}:w`).row();
        kb.text("ℹ️ Details", `sl:${rest[0]}:i`).row();
        kb.text("« Back", "sl:back");
        await ctx.editMessageText(txt, { parse_mode: "HTML", reply_markup: kb }).catch(() => undefined);
        return void done();
      }
      // A real action: collapse the menu back to the project's session list first.
      await restoreList();
      await done();
      // Resume/fork/close mutate state — never act on the cached snapshot's live/pid flags.
      if (rest[1] === "r" || rest[1] === "f" || rest[1] === "c") s = await findSessionFresh(sid);
      if (!s) { await cockpit.say(null, "That session is gone (or the list is stale) — run /sessions again."); return; }
      if (rest[1] === "r") await resumeLocal(s, false);
      else if (rest[1] === "f") await resumeLocal(s, true);
      else if (rest[1] === "c") {
        // Close a stale foreign live session (open on the Mac/desktop) so it frees up to resume
        // here. The pid comes from the FRESH re-read above (finding #7); before signaling, also
        // verify the process still looks like a Claude session — never touch a recycled pid.
        const pid = s.pid;
        if (!s.live || !pid) { await cockpit.say(null, "It isn't live on the Mac anymore — run /sessions again and use Continue here."); return; }
        let cmd = "";
        try { cmd = (await execFileP("/bin/ps", ["-p", String(pid), "-o", "command="], { timeout: 4000 })).stdout.trim(); } catch { /* already gone */ }
        if (cmd && !/claude/i.test(cmd)) {
          await cockpit.say(null, `⚠️ pid ${pid} no longer looks like a Claude session (<code>${esc(cmd.slice(0, 80))}</code>) — not touching it. Run /sessions again.`);
          return;
        }
        const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        for (let i = 0; i < 12 && alive(); i++) await new Promise((r) => setTimeout(r, 500));
        if (alive()) { try { process.kill(pid, "SIGKILL"); } catch { /* */ } await new Promise((r) => setTimeout(r, 800)); }
        if (alive()) { await cockpit.say(null, `⚠️ Couldn't close it (pid ${pid} still running — it may be mid-task). Try again, or Fork.`); return; }
        s.live = false; s.pid = undefined;
        await cockpit.say(null, `🛑 Closed on the Mac (pid ${pid}). Resuming here…`);
        await resumeLocal(s, false);
      }
      else if (rest[1] === "w") {
        const rec: SessionRec = {
          key: store.newKey(), sessionId: s.sessionId, cwd: sessionCwd(s.file) ?? s.cwd,
          account: s.account, mode: "n/a", status: "watching", kind: "watch",
          title: `👁 ${s.title ?? path.basename(s.cwd)}`, createdAt: Date.now(), lastActivityAt: Date.now(),
        };
        rec.topicId = await cockpit.makeTopic(rec.title!);
        await cockpit.watch(s.file, rec);
        await cockpit.say(rec, `👁 Watching <b>${esc(s.title ?? s.sessionId.slice(0, 8))}</b> — new activity will mirror here. /unwatch to stop.\n<i>To type into it: open it on the Mac (it's live there) or Fork it here.</i>`);
      } else if (rest[1] === "i") {
        const t = transcriptContextPct(s.file);
        await cockpit.say(null, [
          `ℹ️ <b>${esc(s.title ?? s.sessionId)}</b>`,
          `<code>${esc(s.sessionId)}</code>`,
          `cwd <code>${esc(sessionCwd(s.file) ?? s.cwd)}</code>`,
          `account <b>${esc(s.account)}</b> · ${s.live ? `🟢 live (pid ${s.pid})` : `⚪️ last active ${fmtAgo(s.mtime)}`} · ${(s.size / 1024).toFixed(0)}KB`,
          t ? `context ~${fmtPct(t.pct)} · model ${esc(t.model)}` : "",
          s.live ? `open on Mac: <code>open 'claude://resume?session=${esc(s.sessionId)}'</code>` : "",
        ].filter(Boolean).join("\n"));
      }
      return;
    }
    if (head === "use") {
      activeKey = rest[0];
      const t = store.sessions.get(rest[0])?.title ?? rest[0];
      await ctx.editMessageText(`Active session → <b>${esc(t)}</b> ✅`, { parse_mode: "HTML" }).catch(() => undefined);
      return void done();
    }
    if (head === "mo") {
      const rec = recOf(ctx);
      const sess = rec && cockpit.live.get(rec.key);
      if (sess) {
        await sess.setMode(rest[0]);
        store.flushSessions();
        await ctx.editMessageText(`Permission mode → <b>${modeLabel(rest[0])}</b> ✅`, { parse_mode: "HTML" }).catch(() => undefined);
      } else await ctx.editMessageText("No live session here — resume it first.").catch(() => undefined);
      return void done();
    }
    if (head === "ef") {
      const rec = recOf(ctx);
      const sess = rec && cockpit.live.get(rec.key);
      const id = rest[0];
      const label = effortLabel(id);
      if (!rec) {
        await ctx.editMessageText("No session here.").catch(() => undefined);
        return void done();
      }
      if (!sess) {
        rec.effort = id;
        store.flushSessions();
        await ctx.editMessageText(`Effort → <b>${label}</b> ✅ <i>(applies when the session resumes)</i>`, { parse_mode: "HTML" }).catch(() => undefined);
        return void done();
      }
      if (id === "max") {
        await ctx.editMessageText("Effort → <b>Max</b> ✅ <i>(respawning + resuming…)</i>", { parse_mode: "HTML" }).catch(() => undefined);
        await done();
        await cockpit.respawn(sess, { effort: "max" });
        await cockpit.say(rec, "⚡ Effort is now <b>Max</b> — session resumed where it left off.");
        return;
      }
      try {
        await sess.setEffort(id);
        store.flushSessions();
        await ctx.editMessageText(
          `Effort → <b>${label}</b> ✅${id === "ultracode" ? " <i>— multi-agent workflows now on for this session</i>" : ""}`,
          { parse_mode: "HTML" },
        ).catch(() => undefined);
      } catch (e) {
        await ctx.editMessageText(`Couldn't switch effort: ${esc(e instanceof Error ? e.message : String(e))}`).catch(() => undefined);
      }
      return void done();
    }
    if (head === "md") {
      const [key, ref] = rest;
      const sess = cockpit.live.get(key);
      const rec2 = store.sessions.get(key);
      const modelId = getRef("model", ref);
      const choice = modelId ? (modelChoices.get(key)?.find((m) => m.id === modelId) ?? { id: modelId, label: modelId, description: "" }) : undefined;
      if (choice && (sess || rec2)) {
        if (sess) await sess.setModel(choice.id);
        else if (rec2) rec2.model = choice.id;
        store.flushSessions();
        const suffix = sess ? "" : " <i>(applies when the session resumes)</i>";
        await ctx.editMessageText(`Model → <b>${esc(modelVersion(choice))}</b> ✅${suffix}`, { parse_mode: "HTML" }).catch(() => undefined);
      } else await ctx.editMessageText("Expired or the session is gone — run /model again.").catch(() => undefined);
      return void done();
    }
    if (head === "sw") {
      const [key, idx] = rest;
      const rec = store.sessions.get(key);
      const target = cfg.accounts[Number(idx)];
      if (!rec || !target) return void done("Gone — run /sessions.");
      if (rec.account === target.name) {
        await ctx.editMessageText(`Already on <b>${esc(target.name)}</b> ✓`, { parse_mode: "HTML" }).catch(() => undefined);
        return void done();
      }
      await ctx.editMessageText(`🔁 Moving this session to <b>${esc(target.name)}</b>…`, { parse_mode: "HTML" }).catch(() => undefined);
      await done();
      try {
        await cockpit.moveSession(rec, target);
        await cockpit.say(rec, `🔁 This session now runs on <b>${esc(target.name)}</b> — history intact, fresh pool. Just keep typing.`);
      } catch (e) {
        await cockpit.say(rec, `⚠️ Move failed: ${esc(e instanceof Error ? e.message : String(e))}`);
      }
      return;
    }
    if (head === "acc") {
      const a = cfg.accounts[Number(rest[0])];
      if (a) {
        cfg.activeAccount = a.name;
        saveConfig(cfg);
        await ctx.editMessageText(`New sessions will use <b>${esc(a.name)}</b> ✅`, { parse_mode: "HTML" }).catch(() => undefined);
      }
      return void done();
    }
    if (head === "pf") {
      const f = getRef("plan", rest[0]);
      await done();
      if (f && fs.existsSync(f)) await ctx.replyWithDocument(new InputFile(f)).catch(() => undefined);
      else await ctx.reply("That list expired (or the file is gone) — run /plans again.").catch(() => undefined);
      return;
    }
    await done();
  });

  // ---- plain messages: input routing ----
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    // Claude Code's own slash commands pass through to the session; other unknown
    // /commands are dropped (registered bot commands were already consumed above).
    if (text.startsWith("/") && !/^\/(compact|context|clear)\b/.test(text)) return;
    if (pendingForeignRevise) { // revision feedback for a foreign-session plan (owner-only, topic-agnostic)
      const fa = cockpit.foreignApprovals.get(pendingForeignRevise);
      pendingForeignRevise = null;
      if (!fa) return void ctx.reply("That plan prompt expired.");
      fa.resolve({ decision: "deny", reason: `Revise the plan based on this feedback and re-present it: ${text}` });
      return void ctx.reply("✏️ Feedback sent — the desktop session will revise the plan.");
    }
    const tk = `${cfg.chatId}:${ctx.message.message_thread_id ?? 0}`;
    const wait = awaiting.get(tk) ?? awaiting.get(threadKey(ctx));
    if (wait) {
      awaiting.delete(tk);
      awaiting.delete(threadKey(ctx));
      if (wait.type === "dir") {
        const abs = text.trim().startsWith("~") ? text.trim().replace("~", process.env.HOME ?? "") : text.trim();
        const ok = await startSession(path.resolve(abs));
        if (!ok) await ctx.reply(`Directory not found: ${abs}`);
        return;
      }
      const a = cockpit.approvals.get(wait.aid);
      if (!a) return void ctx.reply("That prompt expired.");
      if (wait.type === "planFeedback") {
        a.resolve({ behavior: "deny", message: `Revise the plan based on this feedback: ${text}` });
        cockpit.approvals.delete(wait.aid);
        await ctx.reply("✏️ Feedback sent — Claude is revising the plan.");
      } else {
        // questionOther: a free-text answer for one question. A single single-select question
        // resolves immediately; in a multi-question/multi-select ask it's recorded and the user
        // submits from the keyboard once every question is answered.
        const questions = (a.input.questions as Array<Record<string, unknown>> | undefined) ?? [];
        const instant = questions.length === 1 && !questions[0]?.multiSelect;
        const qi = wait.qIdx ?? 0;
        const q = questions[qi];
        if (instant || !q) {
          a.resolve({ behavior: "allow", updatedInput: { ...a.input, answers: { [String(q?.question ?? "q")]: text } } });
          cockpit.approvals.delete(wait.aid);
          qState.delete(wait.aid);
          await ctx.reply("💬 Answer sent.");
        } else {
          const sel = qState.get(wait.aid) ?? new Map<number, Set<number> | string>();
          sel.set(qi, text);
          qState.set(wait.aid, sel);
          if (a.messageId && cfg.chatId)
            await bot.api.editMessageReplyMarkup(cfg.chatId, a.messageId, { reply_markup: cockpit.questionKb(a, sel) }).catch(() => undefined);
          await ctx.reply(`💬 Recorded for question ${qi + 1} — tap 📨 Submit answers once every question is answered.`);
        }
      }
      return;
    }
    const rec = recOf(ctx);
    if (!rec) return void ctx.reply("No session bound here. /new to start one, /sessions to resume, /use to pick (flat mode).");
    if (rec.kind === "watch") return void ctx.reply("This is a watch-only mirror. Fork it (/sessions → Fork) to interact.");
    let sess = cockpit.live.get(rec.key);
    if ((!sess || !sess.running) && rec.sessionId) { // also resume a dead-but-lingering session (finding #4)
      await ctx.reply("💤 Session was detached — resuming…");
      sess = await cockpit.spawn(rec, { resume: rec.sessionId });
    }
    if (!sess) return void ctx.reply("Session is gone. /new to start fresh.");
    sess.send(text);
  });

  bot.on("message:photo", async (ctx) => {
    const rec = recOf(ctx);
    if (!rec) return void ctx.reply("No session here — /new or /sessions first.");
    let sess = cockpit.live.get(rec.key);
    if ((!sess || !sess.running) && rec.kind === "managed" && rec.sessionId) {
      // Same auto-resume as typed text: a detached (or dead-but-lingering) session should accept photos too.
      await ctx.reply("💤 Session was detached — resuming…");
      await cockpit.spawn(rec, { resume: rec.sessionId });
      sess = cockpit.live.get(rec.key);
    }
    if (!sess) return void ctx.reply("No live session here for the photo.");
    try {
      const MAX_PHOTO = 15 * 1024 * 1024;
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const f = await ctx.api.getFile(photo.file_id);
      if (f.file_size && f.file_size > MAX_PHOTO) return void ctx.reply("That image is too large (>15 MB).");
      const url = `https://api.telegram.org/file/bot${token}/${f.file_path}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) return void ctx.reply(`Couldn't download the photo (HTTP ${resp.status}).`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_PHOTO) return void ctx.reply("That image is too large (>15 MB).");
      sess.sendImage(buf.toString("base64"), "image/jpeg", ctx.message.caption);
      await ctx.reply("🖼 sent to Claude.");
    } catch (e) {
      await ctx.reply(`Photo failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  void bot.api.setMyCommands([
    { command: "new", description: "New session in a directory" },
    { command: "sessions", description: "All local sessions (resume/fork/watch)" },
    { command: "info", description: "Full details: session, usage, limits, account" },
    { command: "usage", description: "5h + weekly limits per account" },
    { command: "health", description: "Self-check: CLI, away-mode, accounts, pairing" },
    { command: "bindchat", description: "Move the cockpit to THIS chat (confirmed)" },
    { command: "model", description: "Switch model" },
    { command: "mode", description: "Switch permission mode" },
    { command: "effort", description: "Switch effort level" },
    { command: "stop", description: "Interrupt the current turn" },
    { command: "copy", description: "Re-send last output as copyable block" },
    { command: "plan", description: "Show current plan" },
    { command: "tasks", description: "Background tasks/todos" },
    { command: "files", description: "git status in session cwd" },
    { command: "routines", description: "Local scheduled tasks" },
    { command: "groups", description: "Session groups" },
    { command: "account", description: "Switch/add Claude account" },
    { command: "foreign", description: "Away-mode: relay desktop prompts to phone" },
    { command: "help", description: "All commands" },
  ]).catch(() => undefined);

  return { bot, cockpit };
}
