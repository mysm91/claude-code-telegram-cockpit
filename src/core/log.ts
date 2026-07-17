// Redacted logging. The daemon's stdout/stderr go to bridge-state/logs/*, which must never
// contain secrets or full home paths. Rather than audit every call site, we wrap console.* once
// at startup so every line — wherever it came from — is scrubbed. Short values (e.g. the 11-char
// pairing code) are intentionally NOT matched, so first-run pairing still works from the log.
import os from "node:os";

const home = os.homedir();

const PATTERNS: Array<[RegExp, string]> = [
  [/hvs\.[A-Za-z0-9._-]+/g, "hvs.«redacted»"],                 // Vault
  [/ntn_[A-Za-z0-9]+/g, "ntn_«redacted»"],                     // Notion
  [/sk-[A-Za-z0-9-]{20,}/g, "sk-«redacted»"],                  // API keys
  [/xox[abprs]-[A-Za-z0-9-]+/g, "xox«redacted»"],              // Slack
  [/bot\d{6,}:[A-Za-z0-9_-]{30,}/g, "bot«redacted»"],          // Telegram bot token
  [/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1«redacted»"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "«redacted-hex»"],                 // sha256 / OAuth / away-mode tokens
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "«redacted-token»"],     // long base64-ish blobs
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "«email»"],
];

/** Scrub secrets + home paths from a log string. */
export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  out = out.replace(/\/Users\/[^/\s"']+/g, "~"); // any user's home dir → ~
  if (home) out = out.split(home).join("~");
  return out;
}

/** Wrap console.{log,error,warn,info} so every emitted line is redacted. Call once at startup. */
export function installRedactedConsole(): void {
  const scrub = (a: unknown): unknown =>
    a instanceof Error ? redact(a.stack ?? a.message) : typeof a === "string" ? redact(a) : a;
  for (const m of ["log", "error", "warn", "info"] as const) {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]): void => orig(...args.map(scrub));
  }
}
