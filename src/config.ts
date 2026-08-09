// Configuration + secrets. Secrets live ONLY in the macOS Keychain; config.json holds
// non-secret preferences and is created/updated by the daemon itself.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AccountCfg {
  name: string;
  /** null = the default ~/.claude (claude-max). Otherwise an absolute CLAUDE_CONFIG_DIR path
   *  that must stay byte-identical everywhere (keychain entry is keyed on the literal string). */
  configDir: string | null;
}

export interface BridgeConfig {
  /** Telegram numeric user id of the owner. Set during pairing; only this id is served. */
  ownerId?: number;
  /** Chat where the cockpit lives (private chat or forum supergroup). Set during pairing. */
  chatId?: number;
  /** Whether the chat supports forum topics (detected on first session). */
  forumMode?: boolean;
  accounts: AccountCfg[];
  /** Account used for new sessions. */
  activeAccount: string;
  defaults: { model?: string; mode: string; effort?: string };
  /** Warn in Telegram when 5h window crosses this percentage. */
  usageWarnPct: number;
  /** Auto-deny a managed permission/plan/question prompt if it goes unanswered for this many
   *  minutes — a fail-safe so a never-tapped prompt (or a failed Telegram send) can't hang the
   *  session forever. Tunable via bridge-state/config.json; default 15. */
  approvalTimeoutMin?: number;
  /** Try Telegram's Rich Messages (native tables/headings, Bot API 10.1) for replies that
   *  contain them, falling back to HTML. Old clients show "update your Telegram" instead of
   *  the content, so this is opt-in per install. */
  richMessages?: boolean;
  /** Absolute path to a `claude` executable for spawned sessions. Unset = the SDK's bundled
   *  CLI (recommended: SDK and CLI are version-paired). Advanced escape hatch only. */
  claudeExecutable?: string;
  /** Voice notes in (transcribed via the local gemini CLI) and spoken replies out (edge-tts).
   *  Both talk to third parties — see README's egress list. All fields optional; defaults
   *  live in core/voice.ts resolveVoice() (loadConfig's spread is shallow, so nested
   *  defaults here would be clobbered by a partial `voice` object in config.json). */
  voice?: {
    /** GOOGLE_CLOUD_PROJECT for the gemini CLI. Unset = let the CLI resolve it itself. */
    googleCloudProject?: string;
    sttModel?: string;
    sttMaxDurationSec?: number;
    sttMaxBytes?: number;
    sttTimeoutMs?: number;
    /** off = never speak · auto = only reply by voice to a voice prompt · always = every reply. */
    replies?: "off" | "auto" | "always";
    /** How to run edge-tts (it is not a bridge dependency). Default "uvx" — set an absolute
     *  path when uvx is not on the daemon's launchd PATH. */
    uvxPath?: string;
    faVoice?: string;
    enVoice?: string;
    ttsMaxChars?: number;
    ttsTimeoutMs?: number;
  };
}

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // project root (dist/..); fileURLToPath decodes %20/unicode so paths with spaces work
export const HOME = os.homedir();
export const STATE_DIR = path.join(HOME, ".claude", "bridge-state");
export const CONFIG_PATH = path.join(STATE_DIR, "config.json");

const DEFAULTS: BridgeConfig = {
  accounts: [{ name: "claude-max", configDir: null }],
  activeAccount: "claude-max",
  defaults: { mode: "default" },
  usageWarnPct: 90,
  approvalTimeoutMin: 15,
};

export function loadConfig(): BridgeConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: BridgeConfig): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

/** Read a secret from the login Keychain. Returns null if absent. */
export function keychain(service: string, account?: string): string | null {
  try {
    const args = ["find-generic-password", "-s", service, "-w"];
    if (account) args.splice(3, 0, "-a", account);
    // stderr discarded: a missing item is normal (an account that was never logged in), and the
    // child's stderr is inherited straight into the log file, bypassing installRedactedConsole().
    return execFileSync("/usr/bin/security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export function botToken(): string | null {
  return keychain("claude-tg-bridge");
}
