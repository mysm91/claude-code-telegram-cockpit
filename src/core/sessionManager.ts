// Managed Claude sessions: one Agent SDK query() per Telegram-created session,
// run in streaming-input mode so we can send follow-ups, switch model/mode, interrupt,
// and answer permission prompts from the phone.
import {
  query,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AccountCfg } from "../config.js";
import type { SessionRec } from "../state.js";

/** The SDK query() function, injectable for tests (the fake-SDK harness drives the session
 *  lifecycle without the real SDK/network/quota). Production always uses the real query. */
type QueryFn = typeof query;
let _query: QueryFn = query;
/** Test-only: swap in a fake query(); pass null to restore the real implementation. */
export function __setQueryForTests(fn: QueryFn | null): void { _query = fn ?? query; }

/** Push-based AsyncIterable used as the query() prompt stream. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(m: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: m, done: false }); }
    else this.buf.push(m);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: undefined as never, done: true }); }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => { this.waiter = res; });
      },
    };
  }
}

export interface PendingApproval {
  id: string;
  sessionKey: string;
  kind: "tool" | "plan" | "question";
  toolName: string;
  title?: string;
  description?: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
  createdAt: number;
  /** Telegram message id of the prompt (set by the bot so it can edit in the verdict). */
  messageId?: number;
}

export interface RateInfo {
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  status?: string;
  at: number;
  account: string;
}

export interface SessionEvents {
  onText(s: ManagedSession, text: string, final: boolean): void;
  onToolUse(s: ManagedSession, name: string, input: Record<string, unknown>): void;
  onApproval(s: ManagedSession, a: PendingApproval): void;
  onResult(s: ManagedSession, info: { costUsd?: number; turns?: number; isError: boolean; subtype: string }): void;
  onRateLimit(s: ManagedSession, info: RateInfo): void;
  onNote(s: ManagedSession, note: string): void;
  onExit(s: ManagedSession, reason: string): void;
}

let approvalSeq = 0;

export class ManagedSession {
  rec: SessionRec;
  account: AccountCfg;
  private input = new InputQueue();
  private q: Query | null = null;
  private abort = new AbortController();
  private events: SessionEvents;
  pending = new Map<string, PendingApproval>();
  lastPlan = "";
  lastFinalText = "";
  running = false;

  constructor(rec: SessionRec, account: AccountCfg, events: SessionEvents) {
    this.rec = rec;
    this.account = account;
    this.events = events;
  }

  private buildOptions(resume?: string): Options {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    if (this.account.configDir) env.CLAUDE_CONFIG_DIR = this.account.configDir;
    // Privacy hardening: sessions talk to the Anthropic API for inference only —
    // no telemetry, no error reporting, no feedback surveys.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    const opts: Options = {
      cwd: this.rec.cwd,
      permissionMode: this.rec.mode as PermissionMode,
      includePartialMessages: true,
      canUseTool: (toolName, input, o) => this.handlePermission(toolName, input, o),
      abortController: this.abort,
      env,
      title: this.rec.title,
    };
    if (this.rec.model) opts.model = this.rec.model;
    if (this.rec.effort === "ultracode") {
      opts.effort = "xhigh";
      opts.settings = { ultracode: true }; // xhigh + standing multi-agent workflow orchestration
    } else if (this.rec.effort) {
      opts.effort = this.rec.effort as Options["effort"];
    }
    if (resume) opts.resume = resume;
    return opts;
  }

  /** Start (or resume) the underlying query and pump its messages. */
  start(firstPrompt?: string, resume?: string): void {
    if (firstPrompt) this.send(firstPrompt);
    this.q = _query({ prompt: this.input, options: this.buildOptions(resume) });
    this.running = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    let partial = "";
    try {
      for await (const msg of this.q as Query) {
        this.rec.lastActivityAt = Date.now();
        const m = msg as SDKMessage & { [k: string]: unknown };
        switch (m.type) {
          case "system": {
            if ((m as { subtype?: string }).subtype === "init") {
              this.rec.sessionId = (m as { session_id?: string }).session_id ?? this.rec.sessionId;
              const model = (m as { model?: string }).model;
              if (model) this.rec.model = model;
            }
            break;
          }
          case "stream_event": {
            const ev = (m as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
              partial += ev.delta.text;
              this.events.onText(this, partial, false);
            }
            break;
          }
          case "assistant": {
            const content = (m as unknown as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? [];
            for (const block of content) {
              if (block.type === "tool_use") {
                this.events.onToolUse(this, String(block.name ?? "?"), (block.input as Record<string, unknown>) ?? {});
              }
            }
            const text = content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
            if (text.trim()) {
              this.lastFinalText = text;
              this.events.onText(this, text, true);
            }
            partial = "";
            break;
          }
          case "result": {
            this.rec.status = "idle";
            this.events.onResult(this, {
              costUsd: (m as { total_cost_usd?: number }).total_cost_usd,
              turns: (m as { num_turns?: number }).num_turns,
              isError: Boolean((m as { is_error?: boolean }).is_error),
              subtype: String((m as { subtype?: string }).subtype ?? ""),
            });
            break;
          }
          case "rate_limit_event": {
            const info = (m as { rate_limit_info?: Record<string, unknown> }).rate_limit_info ?? {};
            this.events.onRateLimit(this, {
              rateLimitType: info.rateLimitType as string | undefined,
              utilization: info.utilization as number | undefined,
              resetsAt: info.resetsAt as number | undefined,
              status: info.status as string | undefined,
              at: Date.now(),
              account: this.account.name,
            });
            break;
          }
          case "auth_status": {
            const err = (m as { error?: string }).error;
            if (err) this.events.onNote(this, `⚠️ Auth problem: ${err}\nRun <code>claude auth login</code> on the Mac for account <b>${this.account.name}</b>.`);
            break;
          }
          default:
            break;
        }
      }
      this.running = false;
      this.rec.status = "closed";
      this.events.onExit(this, "finished");
    } catch (e) {
      this.running = false;
      this.rec.status = "detached";
      const msg = e instanceof Error ? e.message : String(e);
      if (/401|auth|login/i.test(msg)) {
        this.events.onNote(this, `⚠️ Session failed to authenticate (<code>${msg.slice(0, 200)}</code>).\nRun <code>claude auth login</code> on the Mac for account <b>${this.account.name}</b>, then Resume.`);
      }
      this.events.onExit(this, msg.slice(0, 300));
    }
  }

  private handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    o: { suggestions?: PermissionUpdate[]; title?: string; description?: string; signal: AbortSignal },
  ): Promise<PermissionResult> {
    const kind = toolName === "ExitPlanMode" ? "plan" : toolName === "AskUserQuestion" ? "question" : "tool";
    if (kind === "plan") this.lastPlan = String(input.plan ?? "");
    const a: PendingApproval = {
      id: `a${++approvalSeq}`,
      sessionKey: this.rec.key,
      kind,
      toolName,
      title: o.title,
      description: o.description,
      input,
      suggestions: o.suggestions,
      resolve: () => undefined,
      createdAt: Date.now(),
    };
    const p = new Promise<PermissionResult>((resolve) => {
      a.resolve = (r) => { this.pending.delete(a.id); resolve(r); };
    });
    o.signal.addEventListener("abort", () => a.resolve({ behavior: "deny", message: "Aborted." }), { once: true });
    this.pending.set(a.id, a);
    this.events.onApproval(this, a);
    return p;
  }

  send(text: string): void {
    this.rec.status = "running";
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  sendImage(base64: string, mediaType: string, caption?: string): void {
    this.rec.status = "running";
    const content: Array<Record<string, unknown>> = [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    ];
    if (caption) content.push({ type: "text", text: caption });
    this.input.push({
      type: "user",
      message: { role: "user", content: content as never },
      parent_tool_use_id: null,
    });
  }

  async setMode(mode: string): Promise<void> {
    this.rec.mode = mode;
    await this.q?.setPermissionMode(mode as PermissionMode);
  }

  async setModel(model: string): Promise<void> {
    this.rec.model = model;
    await this.q?.setModel(model);
  }

  async interrupt(): Promise<void> { await this.q?.interrupt(); }

  /** Live effort switch via flag settings. 'max' isn't settable live (flag layer caps at
   *  xhigh) — the caller must respawn with Options.effort = 'max'. */
  async setEffort(level: string): Promise<"live" | "needs-respawn"> {
    if (level === "max") { this.rec.effort = "max"; return "needs-respawn"; }
    if (level === "ultracode") {
      await this.q?.applyFlagSettings({ ultracode: true, effortLevel: "xhigh" });
      this.rec.effort = "ultracode";
      return "live";
    }
    await this.q?.applyFlagSettings({ effortLevel: level as "low" | "medium" | "high" | "xhigh", ultracode: null });
    this.rec.effort = level;
    return "live";
  }

  async contextUsage(): Promise<{ percentage: number; totalTokens: number; maxTokens: number; model: string } | null> {
    try {
      const u = await this.q?.getContextUsage();
      if (!u) return null;
      return { percentage: u.percentage, totalTokens: u.totalTokens, maxTokens: u.maxTokens, model: u.model };
    } catch { return null; }
  }

  async loggedInAs(): Promise<{ email?: string; subscriptionType?: string } | null> {
    try { return (await this.q?.accountInfo()) ?? null; } catch { return null; }
  }

  async models(): Promise<Array<{ id: string; label: string; description: string; resolved?: string }>> {
    try {
      const list = (await this.q?.supportedModels()) ?? [];
      return list
        .map((mi) => ({
          id: mi.value,
          label: mi.displayName || mi.value,
          description: mi.description ?? "",
          resolved: mi.resolvedModel,
        }))
        .filter((x) => x.id);
    } catch { return []; }
  }

  /** Close the input stream; the query ends after the current turn. */
  end(): void { this.input.close(); }

  /** Hard kill. */
  kill(): void {
    for (const a of this.pending.values()) a.resolve({ behavior: "deny", message: "Session killed." });
    this.abort.abort();
    this.input.close();
    this.running = false;
    this.rec.status = "closed";
  }
}
