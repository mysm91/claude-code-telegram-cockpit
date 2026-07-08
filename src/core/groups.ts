// Session groups. The bridge owns its own groups (full CRUD). Desktop-app groups live in
// a server-synced LevelDB the app clobbers on launch — we only ever *read* snapshot copies
// (made by ai-tooling/claude-sessions-sync) and even that is best-effort string extraction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Store } from "../state.js";

export function addToGroup(store: Store, group: string, sessionKey: string): void {
  const g = (store.groups[group] ??= { sessions: [], createdAt: Date.now() });
  if (!g.sessions.includes(sessionKey)) g.sessions.push(sessionKey);
  store.flushGroups();
}

export function removeFromGroup(store: Store, group: string, sessionKey: string): void {
  const g = store.groups[group];
  if (!g) return;
  g.sessions = g.sessions.filter((s) => s !== sessionKey);
  if (!g.sessions.length) delete store.groups[group];
  store.flushGroups();
}

/** Best-effort desktop group names from the newest claude-sessions-sync LevelDB snapshot.
 *  Purely informational; may miss or over-match. Never writes anything. */
export function desktopGroupNames(): string[] {
  const backups = path.join(os.homedir(), ".claude-instances", "_backups");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(backups).filter((d) => d.startsWith("sync-") || d.startsWith("KEEP-")).sort().reverse();
  } catch { return []; }
  const names = new Set<string>();
  for (const d of dirs.slice(0, 1)) {
    const stack = [path.join(backups, d)];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!/\.(ldb|log)$/.test(e.name)) continue;
        try {
          const raw = fs.readFileSync(full).toString("latin1");
          if (!raw.includes("dframe")) continue;
          for (const m of raw.matchAll(/"name"\s*:\s*"([^"\\]{2,40})"/g)) {
            const n = m[1];
            if (/^[\w ؀-ۿ-]{2,40}$/.test(n)) names.add(n);
          }
        } catch { /* skip */ }
      }
    }
  }
  return [...names].slice(0, 30);
}
