// The model list behind /model. Full model ids come from the CLI the SDK spawns (read off the
// connect handshake, no turn sent) and are cached on disk so the menu works right after a daemon
// restart; the cache is keyed on the SDK version so an SDK bump re-probes by itself.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ROOT, STATE_DIR, type AccountCfg, type BridgeConfig } from "../config.js";
import { sdkQuery } from "./sdk.js";

export interface ModelRow { id: string; label: string; description: string; resolved?: string }
export interface MenuRow { id: string; label: string; hint: string; current: boolean; alias: boolean }
export interface Catalog { key?: string; fetchedAt?: number; models: ModelRow[] }

/** Claude Code's own model aliases: Anthropic re-points each one at the current model of that
 *  tier, and setModel() takes them verbatim — which is what keeps this menu from going stale.
 *  "default" is the no-pin sentinel (let the CLI choose), not a string the CLI is sent. */
export const ALIAS_MODELS: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: "default", label: "Default", hint: "whatever the CLI picks — follows the recommended model as it changes" },
  { id: "best", label: "Best", hint: "the most capable model this account may use" },
  { id: "fable", label: "Fable", hint: "flagship for the hardest, longest-running work" },
  { id: "opus", label: "Opus", hint: "deep reasoning" },
  { id: "sonnet", label: "Sonnet", hint: "balanced everyday model" },
  { id: "haiku", label: "Haiku", hint: "fastest and lightest" },
  { id: "opusplan", label: "Opus plan", hint: "Opus while planning, Sonnet for the execution" },
  { id: "fable[1m]", label: "Fable (1M)", hint: "Fable with a 1M-token context window" },
  { id: "opus[1m]", label: "Opus (1M)", hint: "Opus with a 1M-token context window" },
  { id: "sonnet[1m]", label: "Sonnet (1M)", hint: "Sonnet with a 1M-token context window" },
  { id: "opusplan[1m]", label: "Opus plan (1M)", hint: "Opus plan with a 1M-token context window" },
];

const CACHE_FILE = path.join(STATE_DIR, "models-cache.json");
const CATALOG_ROWS = 8;
const PROBE_TIMEOUT_MS = 30_000;

let _pkg: { version: string; cli: string } | null = null;
function sdkPkg(): { version: string; cli: string } {
  if (_pkg) return _pkg;
  try {
    const p = path.join(ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: unknown; claudeCodeVersion?: unknown };
    _pkg = { version: String(raw.version ?? "unknown"), cli: String(raw.claudeCodeVersion ?? "unknown") };
  } catch { _pkg = { version: "unknown", cli: "unknown" }; }
  return _pkg;
}

/** Installed @anthropic-ai/claude-agent-sdk version ("unknown" if unreadable). */
export function sdkVersion(): string { return sdkPkg().version; }

/** Claude Code version bundled with that SDK — what actually serves the catalog (/health drift). */
export function bundledCliVersion(): string { return sdkPkg().cli; }

/** Cache-invalidation key: the catalog is served by the SDK's bundled CLI, so the SDK version is
 *  the right key — unless an override binary is configured, whose own version is then part of it. */
export function catalogKey(cfg: BridgeConfig): string {
  if (!cfg.claudeExecutable) return sdkVersion();
  let v = "unknown";
  try {
    const out = execFileSync(cfg.claudeExecutable, ["--version"], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
    v = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "unknown";
  } catch { /* unreadable override: key stays <sdk>:unknown */ }
  return `${sdkVersion()}:${v}`;
}

function asRow(v: unknown): ModelRow | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : "";
  if (!id) return null;
  const row: ModelRow = {
    id,
    label: typeof m.label === "string" && m.label ? m.label : id,
    description: typeof m.description === "string" ? m.description : "",
  };
  if (typeof m.resolved === "string" && m.resolved) row.resolved = m.resolved;
  return row;
}

export function loadCatalog(): Catalog {
  try {
    const d = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Record<string, unknown>;
    const models: ModelRow[] = [];
    for (const entry of Array.isArray(d.models) ? (d.models as unknown[]) : []) {
      const row = asRow(entry);
      if (row) models.push(row);
    }
    return {
      key: typeof d.key === "string" ? d.key : undefined,
      fetchedAt: typeof d.fetchedAt === "number" ? d.fetchedAt : undefined,
      models,
    };
  } catch { return { models: [] }; }
}

export function saveCatalog(models: ModelRow[], key: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = CACHE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ key, fetchedAt: Date.now(), models }, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

/** SDK ModelInfo[] → ModelRow[]; anything unexpected is dropped rather than thrown on. */
export function toModelRows(models: unknown): ModelRow[] {
  if (!Array.isArray(models)) return [];
  const out: ModelRow[] = [];
  for (const entry of models as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const mi = entry as Record<string, unknown>;
    const id = typeof mi.value === "string" ? mi.value : "";
    if (!id) continue;
    const row: ModelRow = {
      id,
      label: typeof mi.displayName === "string" && mi.displayName ? mi.displayName : id,
      description: typeof mi.description === "string" ? mi.description : "",
    };
    if (typeof mi.resolvedModel === "string" && mi.resolvedModel) row.resolved = mi.resolvedModel;
    out.push(row);
  }
  return out;
}

/** Alias rows (decorated from the catalog when it knows them) followed by full-id catalog rows.
 *  `stalePin` is set when the session's pinned id is nowhere in the catalog — the caller warns;
 *  the pin itself is never rewritten. */
export function buildModelMenu(catalog: ModelRow[], rec: { model?: string; resolvedModel?: string }): { rows: MenuRow[]; stalePin?: string } {
  const pin = rec.model;
  const isCurrent = (id: string, resolved?: string): boolean =>
    pin === undefined ? id === "default" : id === pin || resolved === pin;
  const rows: MenuRow[] = ALIAS_MODELS.map((a) => {
    const cat = catalog.find((m) => m.id === a.id || m.resolved === a.id);
    return {
      id: a.id,
      label: a.label,
      hint: cat ? cat.description || cat.label : a.hint,
      current: isCurrent(a.id, cat?.resolved),
      alias: true,
    };
  });
  const aliasIds = new Set(ALIAS_MODELS.map((a) => a.id));
  for (const m of catalog.filter((m) => !aliasIds.has(m.id)).slice(0, CATALOG_ROWS)) {
    rows.push({ id: m.id, label: m.label, hint: m.description || m.resolved || "", current: isCurrent(m.id, m.resolved), alias: false });
  }
  const stale = pin !== undefined && !aliasIds.has(pin) && !catalog.some((m) => m.id === pin || m.resolved === pin);
  return stale ? { rows, stalePin: pin } : { rows };
}

/** Read the catalog off a connect handshake. No user message is ever sent, so no turn is billed. */
export async function probeModels(account: AccountCfg, cfg: BridgeConfig): Promise<ModelRow[]> {
  const abortController = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    const opts: Options = { cwd: STATE_DIR, env, persistSession: false, maxTurns: 1, abortController };
    if (cfg.claudeExecutable) opts.pathToClaudeCodeExecutable = cfg.claudeExecutable;
    // A prompt stream that never yields: the handshake carries the model list, and pushing a user
    // message would start a real (billed) turn.
    const prompt: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined) }),
    };
    const init = sdkQuery()({ prompt, options: opts }).initializationResult();
    void init.catch(() => undefined); // an abort-driven rejection after the timeout must not go unhandled
    const res = await Promise.race([
      init,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("model probe timed out")), PROBE_TIMEOUT_MS); }),
    ]);
    return toModelRows((res as { models?: unknown } | undefined)?.models);
  } catch (e) {
    console.error("modelCatalog: model probe failed:", e instanceof Error ? e.message : String(e));
    return [];
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
}

export async function refreshCatalogIfStale(account: AccountCfg, cfg: BridgeConfig): Promise<void> {
  try {
    const key = catalogKey(cfg);
    const cached = loadCatalog();
    if (cached.key === key && cached.models.length) return;
    const models = await probeModels(account, cfg);
    if (models.length) saveCatalog(models, key);
  } catch (e) {
    console.error("modelCatalog: catalog refresh failed:", e instanceof Error ? e.message : String(e));
  }
}
