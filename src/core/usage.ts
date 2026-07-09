// Usage/limits (requirement 11): three sources, best-first.
//   1. In-stream SDKRateLimitEvents from bridge-managed sessions (fresh, per account).
//   2. Statusline snapshots dumped by statusline/collector.py (covers desktop/terminal
//      sessions too — only if the statusLine is registered in ~/.claude/settings.json).
//   3. The undocumented OAuth usage endpoint (per-account token from the Keychain).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HOME, STATE_DIR, keychain, type AccountCfg } from "../config.js";
import type { RateInfo } from "./sessionManager.js";

const CLAUDE_VERSION = "2.1.201"; // for the User-Agent the endpoint requires

export interface WindowUsage { pct?: number; resetsAt?: number; source: string; at: number }
/** needsReauth = the account's access token is present but the API rejected it (401); it must be
 *  re-logged-in on the Mac. We never auto-refresh (that would rotate the CLI's own refresh token). */
export interface AccountUsage { fiveHour?: WindowUsage; sevenDay?: WindowUsage; needsReauth?: boolean }

const streamCache = new Map<string, AccountUsage>(); // account -> latest from rate_limit_events

export function noteRateEvent(info: RateInfo): void {
  const u = streamCache.get(info.account) ?? {};
  const w: WindowUsage = { pct: info.utilization, resetsAt: info.resetsAt, source: "live", at: info.at };
  if (info.rateLimitType === "five_hour") u.fiveHour = w;
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
        "User-Agent": `claude-code/${CLAUDE_VERSION}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429 && attempt < 1) {
      const wait = Math.min((Number(res.headers.get("retry-after")) || 3) * 1000, 5_000);
      await new Promise((r) => setTimeout(r, wait));
      return oauthUsage(a, attempt + 1);
    }
    // Stale/expired token. We do NOT refresh (that would rotate the CLI's own refresh token and log
    // it out) — surface `needsReauth` so the user can re-login on the Mac.
    if (res.status === 401) return { needsReauth: true };
    if (!res.ok) return out;
    const d = (await res.json()) as Record<string, { utilization?: number; resets_at?: string }>;
    const now = Date.now();
    const conv = (w?: { utilization?: number; resets_at?: string }): WindowUsage | undefined =>
      w && w.utilization !== undefined
        ? { pct: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) / 1000 : undefined, source: "api", at: now }
        : undefined;
    out.fiveHour = conv(d.five_hour);
    out.sevenDay = conv(d.seven_day);
  } catch { /* endpoint unreachable / token stale */ }
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
  let merged: AccountUsage = { fiveHour: pick(live.fiveHour, snap.fiveHour), sevenDay: pick(live.sevenDay, snap.sevenDay) };
  let needsReauth = false;
  if (!freshEnough(merged.fiveHour) || !freshEnough(merged.sevenDay)) {
    if (Date.now() >= (nextPoll.get(a.name) ?? 0)) {
      const api = await oauthUsage(a);
      if (api.fiveHour || api.sevenDay) {
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
  merged = { fiveHour: pick(merged.fiveHour, cached.fiveHour), sevenDay: pick(merged.sevenDay, cached.sevenDay) };
  // Only surface "reauth needed" when we have nothing else to show (cached numbers win if present).
  if (needsReauth && !merged.fiveHour && !merged.sevenDay) merged.needsReauth = true;
  return merged;
}

/** Context % of an arbitrary session straight from its transcript (fallback for
 *  foreign sessions; managed sessions use query.getContextUsage() instead). */
export function transcriptContextPct(file: string): { pct: number; model: string } | null {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const len = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
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
