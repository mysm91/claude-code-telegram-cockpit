// Read-only inventory of local Claude Code state: sessions (all accounts, incl. ones
// started in the terminal / desktop app), scheduled routines, plans, background tasks.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AccountCfg } from "../config.js";

const execFileP = promisify(execFile);
const HOME = os.homedir();

const SECRET_FILE_RE = /(^id_(rsa|dsa|ecdsa|ed25519))|(\.(pem|key|p12|pfx|keystore|crt)$)|(credentials)|(secret)/i;
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp)$/i;

/** Resolve `arg` strictly inside `cwd` for sending a file to Telegram — the single source of
 *  truth for /file AND for auto-surfacing files a session writes. Rejects absolute paths, `..`
 *  and symlink escapes (realpath must stay under cwd), dotfiles, known secret/key names, and
 *  anything over the size cap. Returns the real path + metadata, or a human-readable error. */
export function confinedFile(
  cwd: string,
  arg: string,
  maxBytes = 20 * 1024 * 1024,
): { real: string; size: number; isImage: boolean } | { error: string } {
  if (path.isAbsolute(arg)) return { error: "Absolute paths aren't allowed. Give a path relative to the session directory." };
  let cwdReal: string;
  let real: string;
  try {
    cwdReal = fs.realpathSync(cwd);
    real = fs.realpathSync(path.resolve(cwdReal, arg));
  } catch {
    return { error: "No such file in this session's directory." };
  }
  if (real !== cwdReal && !real.startsWith(cwdReal + path.sep)) return { error: "That path resolves outside the session directory — refused." };
  let st: fs.Stats;
  try { st = fs.statSync(real); } catch { return { error: "Couldn't read that file." }; }
  if (!st.isFile()) return { error: "That's not a regular file." };
  if (path.relative(cwdReal, real).split(path.sep).some((s) => s.startsWith("."))) return { error: "Dotfiles (e.g. .env, .ssh, .git) can't be sent — they commonly hold secrets." };
  if (SECRET_FILE_RE.test(path.basename(real))) return { error: "That looks like a key/secret file — refused." };
  if (st.size > maxBytes) return { error: `File too large (${(st.size / 1048576).toFixed(1)} MB > ${(maxBytes / 1048576).toFixed(0)} MB cap).` };
  return { real, size: st.size, isImage: IMAGE_FILE_RE.test(real) };
}

export function configDirOf(a: AccountCfg): string {
  return a.configDir ?? path.join(HOME, ".claude");
}

export interface LocalSession {
  sessionId: string;
  account: string;
  cwd: string;         // real cwd (from the desktop sidecar; no lossy decode)
  realCwd?: string;    // = cwd (kept for callers that resolve lazily)
  projectDir: string;
  file: string;        // transcript path ('' if pruned)
  mtime: number;
  size: number;
  title?: string;
  live?: boolean;
  pid?: number;
  archived?: boolean;
}

/** All desktop-app instance roots that hold a claude-code-sessions index. */
function sidecarRoots(): string[] {
  const roots = [path.join(HOME, "Library/Application Support/Claude")];
  try {
    for (const inst of fs.readdirSync(path.join(HOME, ".claude-instances")))
      if (!inst.startsWith("_")) roots.push(path.join(HOME, ".claude-instances", inst));
  } catch { /* none */ }
  return roots;
}

/** PIDs of live sessions from the CLI's own registry + `claude agents --json`. */
async function liveSessions(): Promise<Map<string, number>> {
  const live = new Map<string, number>();
  const reg = path.join(HOME, ".claude", "sessions");
  try {
    for (const f of fs.readdirSync(reg)) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(reg, f), "utf8"));
        if (d.sessionId && d.pid) {
          try { process.kill(d.pid, 0); live.set(String(d.sessionId), Number(d.pid)); } catch { /* stale */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* no registry */ }
  try {
    const { stdout } = await execFileP("claude", ["agents", "--json"], { timeout: 10_000 });
    for (const a of JSON.parse(stdout)) if (a.sessionId) live.set(String(a.sessionId), Number(a.pid ?? 0));
  } catch { /* older CLI or none */ }
  return live;
}

/** Locate a session's transcript file across the account config dirs (for context %/details). */
function findTranscript(accounts: AccountCfg[], cwd: string, sid: string): { file: string; size: number; mtime: number; account: string } {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  for (const acct of accounts) {
    const full = path.join(configDirOf(acct), "projects", enc, `${sid}.jsonl`);
    try { const st = fs.statSync(full); return { file: full, size: st.size, mtime: st.mtimeMs, account: acct.name }; } catch { /* next */ }
  }
  return { file: "", size: 0, mtime: 0, account: accounts[0]?.name ?? "default" };
}

/** THE session list, sourced from the desktop app's own session index (the local_*.json
 *  sidecars) — so it matches exactly what the user sees in the app: real titles, real cwds,
 *  the archived flag, and the same set (scheduled-task runs excluded, like the app hides them).
 *  De-duplicated by session id across synced instances. Returns the capped slice + honest total. */
export async function listLocalSessions(
  accounts: AccountCfg[],
  limit = 25,
): Promise<{ sessions: LocalSession[]; total: number }> {
  const live = await liveSessions();
  const byId = new Map<string, LocalSession>();
  for (const root of sidecarRoots()) {
    const base = path.join(root, "claude-code-sessions");
    let accts: string[] = [];
    try { accts = fs.readdirSync(base); } catch { continue; }
    for (const acct of accts) {
      let orgs: string[] = [];
      try { orgs = fs.readdirSync(path.join(base, acct)); } catch { continue; }
      for (const org of orgs) {
        const odir = path.join(base, acct, org);
        let files: string[] = [];
        try { files = fs.readdirSync(odir); } catch { continue; }
        for (const f of files) {
          if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
          let d: Record<string, unknown>;
          try { d = JSON.parse(fs.readFileSync(path.join(odir, f), "utf8")); } catch { continue; }
          if (d.scheduledTaskId) continue; // automated runs — the app hides these from the list
          const sid = String(d.cliSessionId ?? d.sessionId ?? "");
          if (!sid || byId.has(sid)) continue; // dedupe across synced instances
          const cwd = String(d.cwd ?? d.originCwd ?? "");
          if (!cwd) continue;
          const t = findTranscript(accounts, cwd, sid);
          const title = String(d.title ?? "").trim() || undefined;
          // sidecar timestamps are epoch-ms integers (not ISO strings). Take the freshest of
          // the sidecar time and the transcript file's mtime — so a bridge-resumed session
          // (which writes the transcript, not the sidecar) shows accurate "last activity".
          const rawTs = d.lastActivityAt ?? d.createdAt;
          const sidecarTs = typeof rawTs === "number" ? rawTs : Date.parse(String(rawTs ?? "")) || 0;
          const ts = Math.max(sidecarTs, t.mtime);
          byId.set(sid, {
            sessionId: sid,
            account: t.account,
            cwd, realCwd: cwd,
            projectDir: t.file ? path.dirname(t.file) : "",
            file: t.file,
            mtime: ts,
            size: t.size,
            title,
            live: live.has(sid),
            pid: live.get(sid),
            archived: Boolean(d.isArchived),
          });
        }
      }
    }
  }
  const out = [...byId.values()].sort((a, b) =>
    Number(b.live ?? false) - Number(a.live ?? false) ||
    Number(a.archived ?? false) - Number(b.archived ?? false) || // active before archived
    b.mtime - a.mtime);
  return { sessions: out.slice(0, limit), total: out.length };
}

const metaCache = new Map<string, { cwd: string | null; firstPrompt: string | null }>();

function firstUserText(msg: unknown): string | null {
  const content = (msg as { content?: unknown })?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content.find((c) => (c as { type?: string }).type === "text") as { text?: string })?.text ?? ""
      : "";
  const t = text.trim();
  // Skip command/system wrappers and tool-result echoes; we want the human's real first ask.
  if (!t || t.startsWith("<") || t.startsWith("Caveat:")) return null;
  return t.replace(/\s+/g, " ").slice(0, 60);
}

/** One generous read of a transcript → its true cwd + the human's first prompt. Cached.
 *  The 1 MB read tolerates a huge opening system message so cwd/prompt are still found,
 *  which is why the same real folder never splits into a lossy-decoded duplicate. */
export function sessionMeta(file: string): { cwd: string | null; firstPrompt: string | null } {
  const hit = metaCache.get(file);
  if (hit) return hit;
  const meta: { cwd: string | null; firstPrompt: string | null } = { cwd: null, firstPrompt: null };
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const fd = fs.openSync(file, "r");
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.includes('"cwd"') && !line.includes('"user"')) continue;
      try {
        const d = JSON.parse(line);
        if (d.cwd && !meta.cwd) meta.cwd = String(d.cwd);
        if (d.type === "user" && !meta.firstPrompt && !d.isSidechain) meta.firstPrompt = firstUserText(d.message);
        if (meta.cwd && meta.firstPrompt) break;
      } catch { /* partial line */ }
    }
  } catch { /* unreadable */ }
  metaCache.set(file, meta);
  return meta;
}

export function sessionCwd(file: string): string | null { return sessionMeta(file).cwd; }

/** The tail of a conversation — the most recent human turn + Claude's last reply — so a
 *  resumed session can show "where it left off" before you continue. Reads the file's end. */
export function sessionTail(file: string, maxChars = 1400): { lastUser?: string; lastAssistant?: string } {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString("utf8", 0, len).split("\n");
    if (st.size > len) lines.shift(); // first line is partial
    const textOf = (c: unknown): string =>
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? (c as Array<{ type?: string; text?: string }>).filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n")
          : "";
    let lastUser: string | undefined;
    let lastAssistant: string | undefined;
    for (const line of lines) {
      if (!line.includes('"type"')) continue;
      try {
        const d = JSON.parse(line);
        if (d.isSidechain) continue;
        if (d.type === "assistant") { const t = textOf(d.message?.content).trim(); if (t) lastAssistant = t; }
        else if (d.type === "user") { const t = textOf(d.message?.content).trim(); if (t && !t.startsWith("<") && !t.startsWith("Caveat:")) lastUser = t; }
      } catch { /* partial line */ }
    }
    return { lastUser: lastUser?.replace(/\s+/g, " ").slice(0, 300), lastAssistant: lastAssistant?.slice(0, maxChars) };
  } catch { return {}; }
}

export interface Routine {
  id: string;
  name: string;
  schedule?: string;
  enabled?: boolean;
  lastRunAt?: string;
  cwd?: string;
  source: string;
}

/** Local scheduled tasks ("routines" that run via the desktop app). */
export function listRoutines(): Routine[] {
  const out: Routine[] = [];
  const seen = new Set<string>();
  const roots = [path.join(HOME, "Library/Application Support/Claude")];
  try {
    for (const inst of fs.readdirSync(path.join(HOME, ".claude-instances"))) {
      if (!inst.startsWith("_")) roots.push(path.join(HOME, ".claude-instances", inst));
    }
  } catch { /* ok */ }
  for (const root of roots) {
    const base = path.join(root, "claude-code-sessions");
    let walk: string[] = [];
    try {
      for (const acct of fs.readdirSync(base))
        for (const org of fs.readdirSync(path.join(base, acct)))
          walk.push(path.join(base, acct, org, "scheduled-tasks.json"));
    } catch { continue; }
    for (const regFile of walk) {
      try {
        const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
        const tasks: Array<Record<string, unknown>> = Array.isArray(reg) ? reg : reg.scheduledTasks ?? reg.tasks ?? [];
        for (const t of tasks) {
          const id = String(t.id ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          let name = String(t.name ?? id);
          try {
            const skill = fs.readFileSync(path.join(HOME, ".claude", "scheduled-tasks", id, "SKILL.md"), "utf8");
            const m = skill.match(/^name:\s*(.+)$/m);
            if (m) name = m[1].trim();
          } catch { /* keep registry name */ }
          out.push({
            id,
            name,
            schedule: (t.cronExpression as string) ?? (t.fireAt ? `once at ${new Date(Number(t.fireAt)).toLocaleString("en-GB")}` : undefined),
            enabled: t.enabled as boolean | undefined,
            lastRunAt: t.lastRunAt as string | undefined,
            cwd: t.cwd as string | undefined,
            source: path.basename(path.dirname(path.dirname(path.dirname(path.dirname(regFile))))),
          });
        }
      } catch { /* no registry here */ }
    }
  }
  return out;
}

export function listPlans(limit = 10): Array<{ name: string; file: string; mtime: number }> {
  const dir = path.join(HOME, ".claude", "plans");
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f, file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch { return []; }
}

/** Background artifacts of one session: subagents, live bash task outputs, todo lists. */
export function sessionTasks(sessionId: string, projectDir?: string): string[] {
  const lines: string[] = [];
  if (projectDir) {
    const sub = path.join(projectDir, sessionId, "subagents");
    try {
      const metas = fs.readdirSync(sub).filter((f) => f.endsWith(".meta.json"));
      for (const f of metas.slice(-10)) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(sub, f), "utf8"));
          lines.push(`🤖 subagent ${d.agentType ?? "?"} — ${String(d.description ?? "").slice(0, 60)}`);
        } catch { /* skip */ }
      }
    } catch { /* none */ }
  }
  try {
    const tmpRoot = `/private/tmp/claude-${process.getuid?.() ?? 501}`;
    for (const enc of fs.readdirSync(tmpRoot)) {
      const tdir = path.join(tmpRoot, enc, sessionId, "tasks");
      try {
        for (const f of fs.readdirSync(tdir)) lines.push(`⚙️ bash task ${f}`);
      } catch { /* none */ }
    }
  } catch { /* none */ }
  try {
    const todoDir = path.join(HOME, ".claude", "tasks", sessionId);
    for (const f of fs.readdirSync(todoDir)) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(todoDir, f), "utf8"));
        lines.push(`📋 ${d.status ?? "?"} — ${String(d.subject ?? f).slice(0, 70)}`);
      } catch { /* skip */ }
    }
  } catch { /* none */ }
  return lines;
}
