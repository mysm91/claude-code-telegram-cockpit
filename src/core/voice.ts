// Voice: speech-to-text via the local gemini CLI, text-to-speech via edge-tts + ffmpeg.
// Both are external processes: execFile with argv arrays, a timeout on every spawn, and no
// function here ever throws (a failed voice note must degrade to a typed message, never crash
// a handler). Transcripts and reply text are NEVER logged — log.ts redaction is secret-shaped,
// not PII-shaped — so only statuses, durations, lengths and error classes go to the log.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BridgeConfig } from "../config.js";

const execFileP = promisify(execFile);

/** Fully resolved voice settings (defaults applied). */
export interface VoiceSettings {
  /** Only genuinely optional field: unset = let the gemini CLI resolve the project itself. */
  googleCloudProject?: string;
  sttModel: string;
  sttMaxDurationSec: number;
  sttMaxBytes: number;
  sttTimeoutMs: number;
  replies: "off" | "auto" | "always";
  uvxPath: string;
  faVoice: string;
  enVoice: string;
  ttsMaxChars: number;
  ttsTimeoutMs: number;
}

export type TranscribeResult = { ok: true; text: string } | { ok: false; error: string };
export type SynthesizeResult = { ok: true; ogg: Buffer; durationSec?: number } | { ok: false; error: string };

/** Per-FIELD defaults: a partial `voice` object in config.json must keep every other default
 *  (loadConfig's spread is shallow, which is why these don't live in config.ts DEFAULTS). */
export function resolveVoice(cfg: BridgeConfig): VoiceSettings {
  const v = cfg.voice ?? {};
  return {
    googleCloudProject: v.googleCloudProject,
    sttModel: v.sttModel ?? "gemini-2.5-pro",
    sttMaxDurationSec: v.sttMaxDurationSec ?? 300,
    sttMaxBytes: v.sttMaxBytes ?? 19 * 1024 * 1024,
    sttTimeoutMs: v.sttTimeoutMs ?? 120_000,
    replies: v.replies ?? "auto",
    uvxPath: v.uvxPath ?? "uvx",
    faVoice: v.faVoice ?? "fa-IR-DilaraNeural",
    enVoice: v.enVoice ?? "en-US-AriaNeural",
    ttsMaxChars: v.ttsMaxChars ?? 2500,
    ttsTimeoutMs: v.ttsTimeoutMs ?? 60_000,
  };
}

// Persian/Arabic letters and marks written as explicit code points, deliberately EXCLUDING both
// digit ranges (U+0660-0669 Arabic-Indic, U+06F0-06F9 Persian), the number punctuation
// (U+066A-066D) and the standalone signs (U+0600-061F): an otherwise-English reply that quotes a
// Persian numeral must still be spoken by the English voice.
const PERSIAN_LETTERS = /[\u0620-\u065F\u066E-\u06EF\u06FA-\u06FF]/;

/** Does the text contain Persian/Arabic letters? Decides which TTS voice speaks it. */
export function hasPersian(s: string): boolean {
  return PERSIAN_LETTERS.test(s);
}

/** Markdown → speakable plain text: markup, code, tables and URLs are unspeakable, so they go.
 *  Caps at maxChars on a word boundary (the caller tells the user it was cut). */
export function speechText(md: string, maxChars: number): { text: string; truncated: boolean } {
  const outside = md.split(/```/).filter((_, i) => i % 2 === 0).join("\n");
  const lines: string[] = [];
  for (const raw of outside.split("\n")) {
    if (/^\s*\|.*\|\s*$/.test(raw)) continue;                        // table row (incl. |---| separator)
    if (raw.includes("|") && /^[\s|:-]+$/.test(raw)) continue;        // separator without outer pipes
    let l = raw.replace(/`([^`\n]+)`/g, "$1");
    l = l.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");
    l = l.replace(/https?:\/\/\S+/g, "");
    l = l.replace(/^\s*#{1,6}\s*/, "").replace(/^\s*>+\s*/, "").replace(/^\s*[-*+]\s+/, "");
    l = l.replace(/[*_]/g, "");
    lines.push(l.trimEnd());
  }
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= maxChars) return { text, truncated: false };
  // A cap that lands between the halves of a surrogate pair (an emoji) would leave a lone
  // surrogate in the text handed to the TTS engine and to the Telegram caption.
  let end = maxChars;
  if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  const head = text.slice(0, end);
  const at = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"), head.lastIndexOf("\t"));
  return { text: (at > 0 ? head.slice(0, at) : head).trimEnd(), truncated: true };
}

/** Pull `.response` out of `gemini -o json` stdout. Schema-tolerant: the CLI sometimes prints
 *  log lines before the JSON. Returns null for anything unusable. */
export function parseGeminiJson(stdout: string): string | null {
  const attempt = (s: string): string | null => {
    try {
      const r = (JSON.parse(s) as { response?: unknown }).response;
      return typeof r === "string" && r.trim() ? r.trim() : null;
    } catch { return null; }
  };
  const direct = attempt(stdout);
  if (direct) return direct;
  const i = stdout.indexOf("{");
  return i < 0 ? null : attempt(stdout.slice(i));
}

// Extensions the gemini CLI accepts for audio, plus .m4a/.mp4 which transcribe() remuxes first.
const AUDIO_EXTS = new Set([".ogg", ".oga", ".mp3", ".aac", ".wav", ".flac", ".m4a", ".mp4"]);
const EXT_BY_MIME: Record<string, string> = {
  "audio/ogg": ".ogg", "audio/opus": ".ogg", "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
  "audio/aac": ".aac", "audio/aacp": ".aac", "audio/wav": ".wav", "audio/wave": ".wav",
  "audio/x-wav": ".wav", "audio/flac": ".flac", "audio/x-flac": ".flac",
  "audio/mp4": ".m4a", "audio/m4a": ".m4a", "audio/x-m4a": ".m4a", "video/mp4": ".mp4",
};

/** Extension to transcribe an `audio` message as, from its file name or mime type.
 *  null = a format we don't send to the CLI (the caller replies with the supported list). */
export function audioExt(name: string | undefined, mime: string | undefined): string | null {
  const byName = (name ?? "").toLowerCase().match(/\.[a-z0-9]{2,5}$/)?.[0];
  if (byName && AUDIO_EXTS.has(byName)) return byName;
  return EXT_BY_MIME[(mime ?? "").toLowerCase().split(";")[0].trim()] ?? null;
}

const STT_PROMPT =
  "Transcribe this voice message verbatim in its original language(s); it may mix Persian and " +
  "English. Output ONLY the transcript text - no preamble, no timestamps, no speaker labels, no " +
  "Persian short-vowel diacritics. If the audio is silent or unintelligible, output exactly [inaudible].";

/** Short, log-safe class of an execFile rejection (never carries stdout/stderr content). */
function execError(e: unknown): { missing: boolean; reason: string } {
  const err = e as { code?: string | number; killed?: boolean } | null;
  if (err?.code === "ENOENT") return { missing: true, reason: "not installed" };
  if (err?.killed) return { missing: false, reason: "timed out" };
  if (typeof err?.code === "number") return { missing: false, reason: `exited ${err.code}` };
  return { missing: false, reason: "failed" };
}

const mkTmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
};

/** Transcribe audio through the local gemini CLI. Never throws; the tmpdir is always removed.
 *  Kept out of any session cwd so the written-files watcher can never pick these up. */
export async function transcribe(audio: Buffer, ext: string, vs: VoiceSettings): Promise<TranscribeResult> {
  let dir: string | null = null;
  try {
    dir = mkTmp("tg-voice-");
    let file = `voice${ext}`;
    fs.writeFileSync(path.join(dir, file), audio);
    if (ext === ".m4a" || ext === ".mp4") {
      // The CLI rejects these extensions; ADTS re-wraps the same AAC stream without re-encoding.
      try {
        await execFileP("ffmpeg", ["-y", "-i", path.join(dir, file), "-c:a", "copy", "-f", "adts", path.join(dir, "voice.aac")],
          { timeout: 30_000, killSignal: "SIGKILL" });
      } catch (e) {
        return { ok: false, error: `couldn't convert that audio (ffmpeg ${execError(e).reason})` };
      }
      file = "voice.aac";
    }
    const env = { ...process.env, ...(vs.googleCloudProject ? { GOOGLE_CLOUD_PROJECT: vs.googleCloudProject } : {}) };
    let reason = "no transcript came back";
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      try {
        const { stdout } = await execFileP("gemini",
          ["--skip-trust", "-m", vs.sttModel, "-o", "json", "--session-id", randomUUID(), "-p", `@${file} ${STT_PROMPT}`],
          { cwd: dir, env, timeout: vs.sttTimeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
        const text = parseGeminiJson(stdout);
        if (text && /^\[inaudible\]\.?$/i.test(text)) return { ok: false, error: "the audio was silent or unintelligible" };
        if (text) {
          console.log(`voice: transcribed in ${Math.round((Date.now() - started) / 1000)}s, ${text.length} chars`);
          return { ok: true, text };
        }
        reason = "unreadable gemini output";
      } catch (e) {
        const { missing, reason: r } = execError(e);
        if (missing) return { ok: false, error: "gemini CLI not found" };
        reason = `gemini ${r}`;
      }
      console.log(`voice: transcription attempt ${attempt + 1} failed (${reason})`);
    }
    return { ok: false, error: reason };
  } catch {
    return { ok: false, error: "couldn't stage the audio locally" };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

/** Speak text as a Telegram-ready OGG/Opus voice note (edge-tts → ffmpeg). Never throws. */
export async function synthesize(text: string, vs: VoiceSettings): Promise<SynthesizeResult> {
  if (!text.trim()) return { ok: false, error: "nothing to speak" };
  let dir: string | null = null;
  let step = "edge-tts";
  try {
    dir = mkTmp("tg-tts-");
    const mp3 = path.join(dir, "reply.mp3");
    const ogg = path.join(dir, "reply.ogg");
    await execFileP(vs.uvxPath, ["edge-tts", "--voice", hasPersian(text) ? vs.faVoice : vs.enVoice, "--text", text, "--write-media", mp3],
      { timeout: vs.ttsTimeoutMs, killSignal: "SIGKILL" });
    step = "ffmpeg";
    await execFileP("ffmpeg", ["-y", "-i", mp3, "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", "-application", "voip", ogg],
      { timeout: 30_000, killSignal: "SIGKILL" });
    let durationSec: number | undefined;
    try {
      const { stdout } = await execFileP("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", ogg],
        { timeout: 10_000, killSignal: "SIGKILL" });
      const d = Number.parseFloat(stdout.trim());
      if (Number.isFinite(d) && d > 0) durationSec = d;
    } catch { /* duration is cosmetic */ }
    return { ok: true, ogg: fs.readFileSync(ogg), durationSec };
  } catch (e) {
    const { missing, reason } = execError(e);
    // The likeliest real failure: uvx is not on the daemon's launchd PATH.
    return { ok: false, error: missing && step === "edge-tts" ? "uvx not found (set voice.uvxPath)" : `${step} ${reason}` };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

let _synthesize: typeof synthesize = synthesize;

/** The synthesize() implementation to use. Call through this so tests can fake the TTS stack. */
export function synthesizeFn(): typeof synthesize { return _synthesize; }

/** Test-only: swap in a fake synthesize(); pass null to restore the real one. */
export function __setSynthesizeForTests(fn: typeof synthesize | null): void { _synthesize = fn ?? synthesize; }
