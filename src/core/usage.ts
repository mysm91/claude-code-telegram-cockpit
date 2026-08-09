// Usage/limits (requirement 11): three sources, best-first.
//   1. In-stream SDKRateLimitEvents from bridge-managed sessions (fresh, per account).
//   2. Statusline snapshots dumped by statusline/collector.py (covers desktop/terminal
//      sessions too — only if the statusLine is registered in ~/.claude/settings.json).
//   3. The undocumented OAuth usage endpoint (per-account token from the Keychain).
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HOME, STATE_DIR, keychain, type AccountCfg, type BridgeConfig } from "../config.js";
import { sdkQuery } from "./sdk.js";
import type { RateInfo } from "./sessionManager.js";

// The usage endpoint wants a claude-code User-Agent. Read the installed CLI's version once
// (lazily, cached) instead of hardcoding it, so it doesn't drift after a Claude Code upgrade.
let _claudeVersion: string | null = null;
function claudeVersion(): string {
  if (_claudeVersion) return _claudeVersion;
  try {
    const out = execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 4000 });
    _claudeVersion = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "2.1.204";
  } catch { _claudeVersion = "2.1.204"; }
  return _claudeVersion;
}

export interface WindowUsage { pct?: number; resetsAt?: number; source: string; at: number }
/** needsReauth = the account's access token is present but the API rejected it (401). We never
 *  auto-refresh (that would rotate the CLI's own refresh token) — see the warm-up note below. */
export interface AccountUsage {
  fiveHour?: WindowUsage;
  sevenDay?: WindowUsage;
  sevenDayOpus?: WindowUsage;
  /** Pay-as-you-go credits beyond the subscription windows (API only, no live/statusline source). */
  extraUsage?: { enabled: boolean; monthlyLimit?: number; usedCredits?: number; utilization?: number };
  needsReauth?: boolean;
}

const streamCache = new Map<string, AccountUsage>(); // account -> latest from rate_limit_events

export function noteRateEvent(info: RateInfo): void {
  const u = streamCache.get(info.account) ?? {};
  const w: WindowUsage = { pct: info.utilization, resetsAt: info.resetsAt, source: "live", at: info.at };
  if (info.rateLimitType === "five_hour") u.fiveHour = w;
  else if (info.rateLimitType?.startsWith("seven_day_opus")) u.sevenDayOpus = w;
  else if (info.rateLimitType?.startsWith("seven_day")) u.sevenDay = w;
  streamCache.set(info.account, u);
}

/** Newest statusline snapshot's rate_limits for a given account (matched by config dir). */
function statuslineUsage(a: AccountCfg): AccountUsage {
  const dir = path.join(STATE_DIR, "status");
  const out: AccountUsage = {};
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return out; }
  let newest: { at: number; rl: Record<string, { used_percentage?: number; resets_at?: number }> } | null = null;
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const cfgDir = String(d._config_dir ?? "");
      const matches = a.configDir ? cfgDir === a.configDir : cfgDir === "";
      if (!matches || !d.rate_limits) continue;
      const at = Number(d._collected_at ?? 0) * 1000;
      if (!newest || at > newest.at) newest = { at, rl: d.rate_limits };
    } catch { /* skip */ }
  }
  if (newest) {
    const { rl, at } = newest;
    if (rl.five_hour?.used_percentage !== undefined)
      out.fiveHour = { pct: rl.five_hour.used_percentage, resetsAt: rl.five_hour.resets_at, source: "statusline", at };
    if (rl.seven_day?.used_percentage !== undefined)
      out.sevenDay = { pct: rl.seven_day.used_percentage, resetsAt: rl.seven_day.resets_at, source: "statusline", at };
  }
  return out;
}

/** Keychain service name for an account's CLI OAuth credentials. */
function credentialService(a: AccountCfg): string {
  if (!a.configDir) return "Claude Code-credentials";
  const hash = createHash("sha256").update(a.configDir.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** Is this account actually logged in (has an OAuth credential in the Keychain)? Lets
 *  /usage & co. render the LIVE set of connected accounts instead of a static config list. */
export function accountConnected(a: AccountCfg): boolean {
  const raw = keychain(credentialService(a));
  if (!raw) return false;
  try { return Boolean(JSON.parse(raw)?.claudeAiOauth?.accessToken); } catch { return false; }
}

// NOTE: we deliberately do NOT refresh access tokens. Calling the OAuth token endpoint rotates the
// refresh token server-side, which would invalidate the Claude CLI's own stored credential and log it
// out globally (the whole account, everywhere). For an idle account whose access token has expired we
// report `needsReauth` and let the user re-login on the Mac. The ACTIVE account's token is kept fresh
// by the CLI itself during normal use, so its usage numbers keep working.
//
// That stance is why an idle bridge account went dark: nothing ran under its CLAUDE_CONFIG_DIR, so
// nothing refreshed it. The fix keeps the stance intact — instead of touching the token endpoint we
// run ONE tiny turn THROUGH the CLI (warmupAccount below), let the CLI refresh and persist its own
// credential the way it does in normal use, and then just re-read the Keychain. The bridge never
// sees, sends, or stores a refresh token.

async function oauthUsage(a: AccountCfg, attempt = 0): Promise<AccountUsage> {
  const out: AccountUsage = {};
  const raw = keychain(credentialService(a));
  if (!raw) return out;
  let token: string | undefined;
  try { token = JSON.parse(raw)?.claudeAiOauth?.accessToken; } catch { return out; }
  if (!token) return out;
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-code/${claudeVersion()}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429 && attempt < 1) {
      const wait = Math.min((Number(res.headers.get("retry-after")) || 3) * 1000, 5_000);
      await new Promise((r) => setTimeout(r, wait));
      return oauthUsage(a, attempt + 1);
    }
    // Stale/expired token. We do NOT refresh (that would rotate the CLI's own refresh token and log
    // it out) — surface `needsReauth` so the user can re-login on the Mac (or warm the account up).
    if (res.status === 401) {
      console.log(`usage: ${a.name} — access token rejected (401); a warm-up ping can renew it via the CLI`);
      return { needsReauth: true };
    }
    if (!res.ok) {
      console.log(`usage: ${a.name} — usage endpoint returned HTTP ${res.status}`);
      return out;
    }
    return parseUsagePayload(await res.json(), Date.now());
  } catch (e) {
    console.log(`usage: fetch failed for ${a.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

/** The usage endpoint's payload → AccountUsage. Undocumented API, so every field is optional and
 *  anything unexpected simply yields `undefined` instead of throwing. */
export function parseUsagePayload(d: unknown, now: number): AccountUsage {
  const out: AccountUsage = {};
  const src = d && typeof d === "object" ? (d as Record<string, unknown>) : {};
  const obj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const conv = (v: unknown): WindowUsage | undefined => {
    const w = obj(v);
    const pct = num(w?.utilization);
    if (pct === undefined) return undefined;
    const reset = typeof w!.resets_at === "string" ? Date.parse(w!.resets_at as string) : NaN;
    return { pct, resetsAt: Number.isNaN(reset) ? undefined : reset / 1000, source: "api", at: now };
  };
  out.fiveHour = conv(src.five_hour);
  out.sevenDay = conv(src.seven_day);
  out.sevenDayOpus = conv(src.seven_day_opus);
  const extra = obj(src.extra_usage);
  if (extra) {
    out.extraUsage = {
      enabled: Boolean(extra.is_enabled),
      monthlyLimit: num(extra.monthly_limit),
      usedCredits: num(extra.used_credits),
      utilization: num(extra.utilization),
    };
  }
  return out;
}

const nextPoll = new Map<string, number>(); // account -> earliest ok time for the next API poll
const CACHE_FILE = path.join(STATE_DIR, "usage-cache.json");

// apiCache survives daemon restarts (each deploy restarts us) so /usage keeps the last
// good numbers per account instead of flashing "no data" until a fresh poll lands.
function loadCache(): Map<string, AccountUsage> {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")))); }
  catch { return new Map(); }
}
const apiCache = loadCache();
function persistCache(): void {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(apiCache))); } catch { /* best-effort */ }
}

/** A window whose reset time has already passed describes the PREVIOUS window — drop it. */
function unexpired(w?: WindowUsage): WindowUsage | undefined {
  if (!w) return undefined;
  if (w.resetsAt && w.resetsAt * 1000 < Date.now() - 60_000) return undefined;
  return w;
}

export async function accountUsage(a: AccountCfg): Promise<AccountUsage> {
  const live = streamCache.get(a.name) ?? {};
  const snap = statuslineUsage(a);
  const pick = (x?: WindowUsage, y?: WindowUsage): WindowUsage | undefined => {
    x = unexpired(x); y = unexpired(y);
    return !x ? y : !y ? x : x.at >= y.at ? x : y;
  };
  const freshEnough = (w?: WindowUsage): boolean => Boolean(unexpired(w) && Date.now() - w!.at < 10 * 60_000);
  let merged: AccountUsage = {
    fiveHour: pick(live.fiveHour, snap.fiveHour),
    sevenDay: pick(live.sevenDay, snap.sevenDay),
    sevenDayOpus: pick(live.sevenDayOpus, snap.sevenDayOpus),
  };
  let needsReauth = false;
  if (!freshEnough(merged.fiveHour) || !freshEnough(merged.sevenDay)) {
    if (Date.now() >= (nextPoll.get(a.name) ?? 0)) {
      const api = await oauthUsage(a);
      if (api.fiveHour || api.sevenDay || api.sevenDayOpus) {
        apiCache.set(a.name, api); persistCache();
        nextPoll.set(a.name, Date.now() + 180_000);       // success: respect the ~180s poll floor
      } else if (api.needsReauth) {
        needsReauth = true;
        nextPoll.set(a.name, Date.now() + 600_000);       // expired token won't self-heal: don't hammer the 401
      } else {
        nextPoll.set(a.name, Date.now() + 20_000);        // transient failure (429/network): retry soon, don't lock out
      }
    }
  }
  const cached = apiCache.get(a.name) ?? {};
  merged = {
    fiveHour: pick(merged.fiveHour, cached.fiveHour),
    sevenDay: pick(merged.sevenDay, cached.sevenDay),
    sevenDayOpus: pick(merged.sevenDayOpus, cached.sevenDayOpus),
    // Credits have no window to expire and no live/statusline source: whatever the last good API
    // poll said is the only reading there is.
    extraUsage: cached.extraUsage,
  };
  // Only surface "reauth needed" when we have nothing else to show (cached numbers win if present).
  if (needsReauth && !merged.fiveHour && !merged.sevenDay && !merged.sevenDayOpus) merged.needsReauth = true;
  return merged;
}

const WARMUP_FILE = path.join(STATE_DIR, "warmup-state.json");
const WARMUP_AUTO_MS = 6 * 60 * 60_000;
const WARMUP_MANUAL_MS = 10 * 60_000;

let warmupState: Record<string, number> | null = null;  // account -> last attempt (ms)
let warmupPersist = true;

function warmups(): Record<string, number> {
  if (warmupState) return warmupState;
  const out: Record<string, number> = {};
  try {
    const d = JSON.parse(fs.readFileSync(WARMUP_FILE, "utf8"));
    if (d && typeof d === "object") for (const [k, v] of Object.entries(d)) if (typeof v === "number") out[k] = v;
  } catch { /* first run or corrupt: an empty throttle just means the next ping is allowed */ }
  warmupState = out;
  return out;
}

/** Test-only: drive the throttle in memory (and stop it writing to the real bridge-state dir);
 *  pass null to go back to the on-disk file. */
export function __setWarmupStateForTests(m: Record<string, number> | null): void {
  warmupState = m ? { ...m } : null;
  warmupPersist = !m;
}

/** Stamp an attempt. Called BEFORE the ping is spawned, so a hung ping can never loop. */
export function markWarmupAttempt(account: string, now = Date.now()): void {
  warmups()[account] = now;
  if (!warmupPersist) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const tmp = WARMUP_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(warmupState));
    fs.renameSync(tmp, WARMUP_FILE);
  } catch { /* best-effort: the in-memory stamp still throttles this daemon run */ }
}

/** A ping costs one haiku turn, so: automatic pings at most every 6 h, taps every 10 min. */
export function shouldWarmup(account: string, opts?: { manual?: boolean; now?: number }): boolean {
  const now = opts?.now ?? Date.now();
  const last = warmups()[account] ?? 0;
  return now - last >= (opts?.manual ? WARMUP_MANUAL_MS : WARMUP_AUTO_MS);
}

/** One-turn haiku ping under the account's CLAUDE_CONFIG_DIR: the CLI refreshes and persists its
 *  own credential, then accountUsage() re-reads the Keychain and gets real numbers again.
 *  `persistSession: false` (sdk.d.ts: "Sessions will not be saved to ~/.claude/projects/") is what
 *  keeps the ping out of /sessions — it touches no Store, no SessionRec, no cockpit state. */
export async function warmupAccount(a: AccountCfg, cfg: BridgeConfig): Promise<{ ok: boolean; error?: string }> {
  markWarmupAttempt(a.name);
  console.log(`usage: warm-up ping for ${a.name} (one haiku turn through the CLI)`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (a.configDir) env.CLAUDE_CONFIG_DIR = a.configDir;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  const abortController = new AbortController();
  const deadline = setTimeout(() => abortController.abort(), 90_000);
  const opts: Options = {
    model: "haiku",
    maxTurns: 1,
    persistSession: false,
    permissionMode: "default",
    cwd: STATE_DIR,
    env,
    abortController,
  };
  if (cfg.claudeExecutable) opts.pathToClaudeCodeExecutable = cfg.claudeExecutable;
  const fail = (error: string): { ok: boolean; error?: string } => {
    console.log(`usage: warm-up ping for ${a.name} failed: ${error}`);
    return { ok: false, error };
  };
  try {
    for await (const m of sdkQuery()({ prompt: "Reply with exactly: pong", options: opts })) {
      const t = (m as { type?: string }).type;
      if (t === "auth_status") {
        const err = (m as { error?: string }).error;
        if (err) return fail(err.slice(0, 200));
      } else if (t === "result") {
        // The CLI puts the human reason in `result` ("Not logged in · Please run /login"), while
        // `subtype` can still read "success" — so the subtype alone is a useless error message.
        const r = m as { is_error?: boolean; subtype?: string; result?: string };
        if (r.is_error) return fail((r.result || `turn failed (${r.subtype ?? "error"})`).slice(0, 200));
        // The 401 backoff exists so we don't hammer a dead token; the token just changed.
        nextPoll.delete(a.name);
        console.log(`usage: warm-up ping for ${a.name} ok`);
        return { ok: true };
      }
    }
    return fail("the ping ended without a result");
  } catch (e) {
    return fail((e instanceof Error ? e.message : String(e)).slice(0, 200));
  } finally {
    clearTimeout(deadline);
    abortController.abort();
  }
}

/** Context % of an arbitrary session straight from its transcript (fallback for
 *  foreign sessions; managed sessions use query.getContextUsage() instead). */
export function transcriptContextPct(file: string): { pct: number; model: string } | null {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.type === "assistant" && !d.isSidechain && d.message?.usage) {
          const u = d.message.usage;
          const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          const model = String(d.message.model ?? "");
          const window = /\[1m\]|-1m/.test(model) || used > 210_000 ? 1_000_000 : 200_000;
          return { pct: Math.min(100, (used / window) * 100), model };
        }
      } catch { /* keep scanning */ }
    }
  } catch { /* unreadable */ }
  return null;
}
