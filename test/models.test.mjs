// Model catalog: pure menu/parse helpers, the on-disk cache, and the zero-cost init probe
// (driven through the fake-SDK seam — no CLI is ever spawned here).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// STATE_DIR is computed from os.homedir() when config.js loads, and os.homedir() honours $HOME on
// POSIX — so redirect HOME first and import everything dynamically, or the cache tests would write
// into the real ~/.claude/bridge-state.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tg-models-"));
process.env.HOME = tmpHome;
process.on("exit", () => fs.rmSync(tmpHome, { recursive: true, force: true }));

const mc = await import("../dist/core/modelCatalog.js");
const { __setQueryForTests } = await import("../dist/core/sessionManager.js");
const { installFakeQuery, makeCfg } = await import("./helpers.mjs");

const STATE_DIR = path.join(tmpHome, ".claude", "bridge-state");
const CACHE = path.join(STATE_DIR, "models-cache.json");
const ACCT = { name: "acct", configDir: "/Users/x/.claude-acct-x" };

const CATALOG = [
  { id: "opus", label: "Opus", description: "Opus 5 · deepest reasoning", resolved: "claude-opus-5" },
  { id: "claude-opus-5", label: "Opus 5", description: "Opus 5 · deepest reasoning" },
  { id: "claude-sonnet-5", label: "Sonnet 5", description: "Sonnet 5 · everyday" },
];

/** Fake query() whose handshake reports `models`; returns the recorded call args. */
function fakeProbe(models) {
  const seen = [];
  __setQueryForTests((args) => {
    seen.push(args);
    return {
      async initializationResult() { return { models }; },
      [Symbol.asyncIterator]() { return { next: () => new Promise(() => undefined) }; },
    };
  });
  return seen;
}

test("toModelRows maps ModelInfo and tolerates junk", () => {
  const rows = mc.toModelRows([
    { value: "claude-opus-5", displayName: "Opus 5", description: "d", resolvedModel: "claude-opus-5-20260101" },
    { value: "bare" },                    // no displayName/description
    { displayName: "no value" },          // unusable
    null, "nope", 7,
  ]);
  assert.deepEqual(rows, [
    { id: "claude-opus-5", label: "Opus 5", description: "d", resolved: "claude-opus-5-20260101" },
    { id: "bare", label: "bare", description: "" },
  ]);
  for (const bad of [null, undefined, {}, "x", 3]) assert.deepEqual(mc.toModelRows(bad), []);
});

test("buildModelMenu: alias rows first, decorated from the catalog", () => {
  const { rows } = mc.buildModelMenu(CATALOG, {});
  const aliases = rows.filter((r) => r.alias);
  assert.equal(aliases.length, mc.ALIAS_MODELS.length);
  assert.deepEqual(rows.slice(0, aliases.length).map((r) => r.id), mc.ALIAS_MODELS.map((a) => a.id));
  const opus = rows.find((r) => r.id === "opus");
  assert.equal(opus.hint, "Opus 5 · deepest reasoning", "catalog description decorates the alias row");
  const haiku = rows.find((r) => r.id === "haiku");
  assert.equal(haiku.hint, mc.ALIAS_MODELS.find((a) => a.id === "haiku").hint, "undecorated alias keeps its static hint");
  // full ids stay available for pinning, and alias ids are not repeated as catalog rows
  const catalogRows = rows.filter((r) => !r.alias).map((r) => r.id);
  assert.deepEqual(catalogRows, ["claude-opus-5", "claude-sonnet-5"]);
});

test("buildModelMenu: current marking (default / by id / by resolved)", () => {
  const onDefault = mc.buildModelMenu(CATALOG, {}).rows;
  assert.deepEqual(onDefault.filter((r) => r.current).map((r) => r.id), ["default"]);

  const byId = mc.buildModelMenu(CATALOG, { model: "sonnet" }).rows;
  assert.deepEqual(byId.filter((r) => r.current).map((r) => r.id), ["sonnet"]);
  assert.equal(byId.find((r) => r.id === "default").current, false);

  const byResolved = mc.buildModelMenu(CATALOG, { model: "claude-opus-5" }).rows;
  const current = byResolved.filter((r) => r.current).map((r) => r.id);
  assert.ok(current.includes("opus"), "alias row whose resolved id matches the pin is current");
  assert.ok(current.includes("claude-opus-5"), "the catalog row for the pinned id is current");
});

test("buildModelMenu: stalePin only for a pin the catalog does not know", () => {
  assert.equal(mc.buildModelMenu(CATALOG, { model: "claude-opus-4-8[1m]" }).stalePin, "claude-opus-4-8[1m]");
  assert.equal(mc.buildModelMenu(CATALOG, { model: "opus" }).stalePin, undefined);
  assert.equal(mc.buildModelMenu(CATALOG, { model: "opus[1m]" }).stalePin, undefined, "alias ids are never stale");
  assert.equal(mc.buildModelMenu(CATALOG, { model: "claude-sonnet-5" }).stalePin, undefined);
  assert.equal(mc.buildModelMenu([], {}).stalePin, undefined, "no pin, no warning");
  assert.equal(
    mc.buildModelMenu([{ id: "x", label: "X", description: "", resolved: "claude-opus-9" }], { model: "claude-opus-9" }).stalePin,
    undefined,
    "matching a catalog row by resolved id is not stale",
  );
});

test("buildModelMenu: catalog rows capped at 8", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `m-${i}`, label: `M${i}`, description: "" }));
  const { rows } = mc.buildModelMenu(many, {});
  assert.equal(rows.filter((r) => !r.alias).length, 8);
  assert.equal(rows.filter((r) => r.alias).length, mc.ALIAS_MODELS.length);
});

test("loadCatalog: missing, corrupt and junk cache files all read as empty", () => {
  fs.rmSync(CACHE, { force: true });
  assert.deepEqual(mc.loadCatalog(), { models: [] });

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CACHE, "{not json");
  assert.deepEqual(mc.loadCatalog(), { models: [] });

  fs.writeFileSync(CACHE, JSON.stringify({ key: 7, fetchedAt: "soon", models: "nope" }));
  assert.deepEqual(mc.loadCatalog(), { key: undefined, fetchedAt: undefined, models: [] });

  fs.writeFileSync(CACHE, JSON.stringify({ key: "k", models: [{ id: "a" }, { label: "no id" }, null, 3] }));
  const c = mc.loadCatalog();
  assert.equal(c.key, "k");
  assert.deepEqual(c.models, [{ id: "a", label: "a", description: "" }]);
  fs.rmSync(CACHE, { force: true });
});

test("saveCatalog → loadCatalog round-trip (temp HOME)", () => {
  const before = Date.now();
  mc.saveCatalog(CATALOG, "sdk-1.2.3");
  const back = mc.loadCatalog();
  assert.equal(back.key, "sdk-1.2.3");
  assert.ok(back.fetchedAt >= before, "fetchedAt is stamped on write");
  assert.deepEqual(back.models, CATALOG);
  assert.ok(fs.existsSync(CACHE), "cache lives in STATE_DIR/models-cache.json");
  assert.equal(fs.existsSync(CACHE + ".tmp"), false, "the temp file is renamed away");
  fs.rmSync(CACHE, { force: true });
});

test("catalogKey: SDK version alone, plus the override binary's version when configured", () => {
  const cfg = makeCfg();
  assert.equal(mc.catalogKey(cfg), mc.sdkVersion());
  assert.match(mc.sdkVersion(), /^\d+\.\d+\.\d+$/, "SDK version read from node_modules");

  const bin = path.join(tmpHome, "fake-claude");
  fs.writeFileSync(bin, "#!/bin/sh\necho '2.1.226 (Claude Code)'\n", { mode: 0o755 });
  assert.equal(mc.catalogKey(makeCfg({ claudeExecutable: bin })), `${mc.sdkVersion()}:2.1.226`);
  assert.equal(mc.catalogKey(makeCfg({ claudeExecutable: "/nope/claude" })), `${mc.sdkVersion()}:unknown`);
});

test("probeModels reads the handshake models and never sends a user message", async () => {
  const seen = fakeProbe([{ value: "claude-opus-5", displayName: "Opus 5", description: "d", resolvedModel: "claude-opus-5-1" }]);
  try {
    const rows = await mc.probeModels(ACCT, makeCfg());
    assert.deepEqual(rows, [{ id: "claude-opus-5", label: "Opus 5", description: "d", resolved: "claude-opus-5-1" }]);
    assert.equal(seen.length, 1);
    const { prompt, options } = seen[0];
    assert.equal(options.cwd, STATE_DIR);
    assert.equal(options.persistSession, false, "the probe must not write a session to ~/.claude/projects");
    assert.equal(options.maxTurns, 1);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, ACCT.configDir);
    assert.equal(options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.ok(options.abortController instanceof AbortController);
    assert.equal(options.pathToClaudeCodeExecutable, undefined);
    // the prompt stream never yields → no turn is ever started → nothing is billed
    const it = prompt[Symbol.asyncIterator]();
    const outcome = await Promise.race([
      it.next().then(() => "yielded"),
      new Promise((r) => setTimeout(() => r("silent"), 30)),
    ]);
    assert.equal(outcome, "silent");
  } finally { __setQueryForTests(null); }
});

test("probeModels passes the claudeExecutable override and omits CLAUDE_CONFIG_DIR for the default account", async () => {
  const seen = fakeProbe([]);
  try {
    await mc.probeModels({ name: "d", configDir: null }, makeCfg({ claudeExecutable: "/opt/claude" }));
    assert.equal(seen[0].options.pathToClaudeCodeExecutable, "/opt/claude");
    assert.equal(seen[0].options.env.CLAUDE_CONFIG_DIR, undefined);
  } finally { __setQueryForTests(null); }
});

test("probeModels returns [] when the handshake fails or reports nothing", async () => {
  const fake = installFakeQuery(); // helpers' fake reports { models: [] }
  try {
    assert.deepEqual(await mc.probeModels(ACCT, makeCfg()), []);
    assert.equal(fake.instances.length, 1);
  } finally { fake.reset(); }

  __setQueryForTests(() => { throw new Error("spawn failed"); });
  try {
    assert.deepEqual(await mc.probeModels(ACCT, makeCfg()), [], "a failed probe is swallowed, never thrown");
  } finally { __setQueryForTests(null); }
});

test("refreshCatalogIfStale: no-op on a matching key, probes and saves otherwise", async () => {
  const cfg = makeCfg();
  mc.saveCatalog(CATALOG, mc.catalogKey(cfg));
  let seen = fakeProbe([{ value: "fresh", displayName: "Fresh", description: "" }]);
  try {
    await mc.refreshCatalogIfStale(ACCT, cfg);
    assert.equal(seen.length, 0, "a cache on the current key is not re-probed");
  } finally { __setQueryForTests(null); }

  mc.saveCatalog(CATALOG, "sdk-0.0.1-stale");
  seen = fakeProbe([{ value: "fresh", displayName: "Fresh", description: "" }]);
  try {
    await mc.refreshCatalogIfStale(ACCT, cfg);
    assert.equal(seen.length, 1);
    const after = mc.loadCatalog();
    assert.equal(after.key, mc.catalogKey(cfg));
    assert.deepEqual(after.models, [{ id: "fresh", label: "Fresh", description: "" }]);
  } finally { __setQueryForTests(null); }

  // an empty probe must not overwrite a usable cache
  mc.saveCatalog(CATALOG, "sdk-0.0.1-stale");
  seen = fakeProbe([]);
  try {
    await mc.refreshCatalogIfStale(ACCT, cfg);
    assert.deepEqual(mc.loadCatalog().models, CATALOG);
  } finally { __setQueryForTests(null); }
  fs.rmSync(CACHE, { force: true });
});

// --- regressions from the 2026-08-09 adversarial review ---

test("buildModelMenu: Default is never ticked while a model is pinned", () => {
  const cat = mc.toModelRows([{ value: "claude-opus-5", displayName: "Opus 5", description: "d", resolvedModel: "claude-opus-5" }]);
  const { rows } = mc.buildModelMenu(cat, { model: "claude-opus-5" });
  assert.equal(rows.find((r) => r.id === "default").current, false, "Default clears the pin, so it is not the current state");
  assert.equal(rows.filter((r) => r.current).length, 1, "exactly one row is current");
});

test("buildModelMenu: a pin the catalog does not know is still selectable", () => {
  const cat = mc.toModelRows([{ value: "claude-opus-5", displayName: "Opus 5", description: "d" }]);
  const { rows, stalePin } = mc.buildModelMenu(cat, { model: "claude-opus-4-8[1m]" });
  assert.equal(stalePin, "claude-opus-4-8[1m]");
  const own = rows.find((r) => r.id === "claude-opus-4-8[1m]");
  assert.ok(own, "the model the session is actually on must appear in the menu");
  assert.equal(own.current, true);
});

// --- the false "may fail" warning (deferred low, closed 2026-08-24) ---
// Staleness was pure set membership, so an EMPTY catalog — a failed probe, or a missing cache
// file — marked every full model id stale and warned that the model the session is happily
// running "may fail on the next turn".

test("buildModelMenu: an empty catalog cannot make a pin stale", () => {
  const { rows, stalePin } = mc.buildModelMenu([], { model: "claude-opus-5" });
  assert.equal(stalePin, undefined, "no catalog is not evidence of staleness");
  const pinned = rows.find((r) => r.id === "claude-opus-5");
  assert.ok(pinned, "the pinned model is still offered back, or it becomes unselectable");
  assert.equal(pinned.current, true, "and it is marked as the current one");
  assert.match(pinned.hint, /unavailable/, `the hint says why, rather than claiming staleness: ${pinned.hint}`);
});

test("buildModelMenu: a populated catalog missing the pin still warns", () => {
  const catalog = [{ id: "claude-sonnet-5", label: "Sonnet", description: "", resolved: "claude-sonnet-5" }];
  const { rows, stalePin } = mc.buildModelMenu(catalog, { model: "claude-opus-4-8" });
  assert.equal(stalePin, "claude-opus-4-8", "a real absence from a real list still warns");
  const pinned = rows.find((r) => r.id === "claude-opus-4-8");
  assert.ok(pinned, "and it stays selectable");
  assert.match(pinned.hint, /not in the current catalog/, "with the staleness wording, not the unavailable one");
});

test("buildModelMenu: an empty catalog never warns about an alias either", () => {
  for (const pin of ["opus", "sonnet", "default", undefined]) {
    const { stalePin } = mc.buildModelMenu([], pin === undefined ? {} : { model: pin });
    assert.equal(stalePin, undefined, `alias ${pin} must never be reported stale`);
  }
});
