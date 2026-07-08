// Away-mode: forward foreign-session (desktop/terminal) permission prompts to Telegram.
// Turning it ON installs a PreToolUse hook into ~/.claude/settings.json AND writes the hook's
// state file; turning it OFF removes the hook entirely (zero overhead when off). Default: off.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, STATE_DIR } from "../config.js";

export const PERM_PORT = 45870;         // localhost only
export const PERM_WAIT_SECONDS = 110;   // hook waits this long for a phone tap, then falls back
const HOOK_CMD = path.join(ROOT, "hooks", "foreign-perm.py");
const STATE_FILE = path.join(STATE_DIR, "foreign-perms.json");
const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

export interface ForeignState { enabled: boolean; idleSeconds: number; port: number; token: string; waitSeconds: number }

function loadToken(): string {
  try { return String(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).token || "") || randomBytes(16).toString("hex"); }
  catch { return randomBytes(16).toString("hex"); }
}

export function foreignState(): ForeignState {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { enabled: false, idleSeconds: 180, port: PERM_PORT, token: loadToken(), waitSeconds: PERM_WAIT_SECONDS }; }
}

function writeState(s: ForeignState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/** Guarantee a state file exists (disabled) with a stable token — so the server and the hook
 *  agree on the token. Also re-syncs the settings.json hook to the persisted enabled flag. */
export function ensureForeignState(): ForeignState {
  let s: ForeignState;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { s = { enabled: false, idleSeconds: 180, port: PERM_PORT, token: randomBytes(16).toString("hex"), waitSeconds: PERM_WAIT_SECONDS }; writeState(s); }
  setHook(s.enabled); // keep settings.json in sync with the persisted flag on every boot
  return s;
}

/** Add/remove our PermissionRequest hook in the shared settings.json, preserving everything
 *  else. Also strips any legacy PreToolUse install of our hook (migration from the old design). */
function setHook(install: boolean): void {
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { /* create fresh */ }
  type Entry = { matcher?: string; hooks: Array<Record<string, unknown>> };
  const hooks = (settings.hooks ?? {}) as Record<string, Entry[]>;
  const strip = (arr?: Entry[]): Entry[] =>
    (arr ?? []).filter((e) => !e.hooks?.some((h) => String(h.command ?? "").includes("foreign-perm.py")));
  hooks.PreToolUse = strip(hooks.PreToolUse); // migrate away from the old PreToolUse hook
  if (!hooks.PreToolUse.length) delete hooks.PreToolUse;
  const pr = strip(hooks.PermissionRequest);
  if (install) pr.push({ matcher: "*", hooks: [{ type: "command", command: HOOK_CMD, timeout: PERM_WAIT_SECONDS + 10 }] });
  if (pr.length) hooks.PermissionRequest = pr; else delete hooks.PermissionRequest;
  settings.hooks = hooks;
  const tmp = SETTINGS + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, SETTINGS);
}

export function enableForeign(idleSeconds: number): ForeignState {
  const s: ForeignState = { enabled: true, idleSeconds, port: PERM_PORT, token: loadToken(), waitSeconds: PERM_WAIT_SECONDS };
  writeState(s);
  setHook(true);
  return s;
}

export function disableForeign(): ForeignState {
  const s = foreignState();
  s.enabled = false;
  writeState(s);
  setHook(false);
  return s;
}
