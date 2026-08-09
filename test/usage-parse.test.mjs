// The usage endpoint is undocumented and can change shape without notice, so the parser must
// degrade to `undefined` rather than throw. Also covers the warm-up throttle, driven through the
// in-memory seam so no test ever writes to the real ~/.claude/bridge-state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../dist/config.js";
import {
  __setWarmupStateForTests,
  markWarmupAttempt,
  parseUsagePayload,
  shouldWarmup,
  warmupAccount,
} from "../dist/core/usage.js";
import { installFakeQuery, makeCfg, msg, tick } from "./helpers.mjs";

const WARMUP_PATH = path.join(STATE_DIR, "warmup-state.json");
const realWarmupFile = fs.existsSync(WARMUP_PATH) ? fs.readFileSync(WARMUP_PATH, "utf8") : null;

const NOW = 1_754_600_000_000; // 2026-08-08T00:53:20Z
// Shaped after a real /api/oauth/usage response (captured 2026-08-09): note that the per-model
// window is reported ONLY through limits[] — seven_day_opus and friends came back null while
// limits[] carried a "Fable" weekly_scoped entry.
const FULL = {
  five_hour: { utilization: 42, resets_at: "2026-08-08T05:00:00Z" },
  seven_day: { utilization: 13.5, resets_at: "2026-08-14T00:00:00Z" },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 12.5, utilization: 12.5 },
  limits: [
    { kind: "session", group: "session", percent: 42, resets_at: "2026-08-08T05:00:00Z", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 13.5, resets_at: "2026-08-14T00:00:00Z", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 7, resets_at: "2026-08-14T00:00:00Z", scope: { model: { id: null, display_name: "Fable" } } },
  ],
};

test("parseUsagePayload: full payload → all windows, ISO resets_at → epoch seconds", () => {
  const u = parseUsagePayload(FULL, NOW);
  assert.deepEqual(u.fiveHour, {
    pct: 42,
    resetsAt: Date.parse("2026-08-08T05:00:00Z") / 1000,
    source: "api",
    at: NOW,
  });
  assert.equal(u.sevenDay.pct, 13.5);
  assert.deepEqual(u.scoped, [{
    name: "Fable",
    win: { pct: 7, resetsAt: Date.parse("2026-08-14T00:00:00Z") / 1000, source: "api", at: NOW },
  }], "a model-scoped weekly window must be read from limits[], not seven_day_<model>");
  assert.equal(u.sevenDay.resetsAt, Date.parse("2026-08-14T00:00:00Z") / 1000);
  assert.ok(Number.isInteger(u.fiveHour.resetsAt), "resetsAt must be seconds, not ms");
  assert.deepEqual(u.extraUsage, { enabled: true, monthlyLimit: 100, usedCredits: 12.5, utilization: 12.5 });
});

test("parseUsagePayload: partial payload leaves the absent windows undefined", () => {
  const u = parseUsagePayload({ five_hour: { utilization: 5, resets_at: "2026-08-08T05:00:00Z" } }, NOW);
  assert.equal(u.fiveHour.pct, 5);
  assert.equal(u.sevenDay, undefined);
  assert.equal(u.scoped, undefined);
  assert.equal(u.extraUsage, undefined);
  assert.equal(u.needsReauth, undefined);
});

test("parseUsagePayload: a window without resets_at still yields its percentage", () => {
  const u = parseUsagePayload({ seven_day: { utilization: 0 } }, NOW);
  assert.equal(u.seven_day, undefined);
  assert.equal(u.sevenDay.pct, 0, "0% is a real reading, not a missing one");
  assert.equal(u.sevenDay.resetsAt, undefined);
  assert.equal(u.sevenDay.at, NOW);
});

test("parseUsagePayload: unparseable resets_at → resetsAt undefined (never NaN)", () => {
  const u = parseUsagePayload({ five_hour: { utilization: 9, resets_at: "whenever" } }, NOW);
  assert.equal(u.five_hour, undefined);
  assert.equal(u.fiveHour.pct, 9);
  assert.equal(u.fiveHour.resetsAt, undefined);
});

test("parseUsagePayload: garbage inputs never throw and report nothing", () => {
  for (const bad of [null, undefined, [], "nope", 42, true, { five_hour: "nope" }, { five_hour: null },
    { five_hour: { utilization: "high" } }, { five_hour: { utilization: NaN } }, { extra_usage: 5 },
    { seven_day: [] }, { five_hour: { resets_at: "2026-08-08T05:00:00Z" } }]) {
    const u = parseUsagePayload(bad, NOW);
    assert.equal(u.fiveHour, undefined, `fiveHour for ${JSON.stringify(bad)}`);
    assert.equal(u.sevenDay, undefined);
    assert.equal(u.scoped, undefined);
  }
  assert.equal(parseUsagePayload({ extra_usage: 5 }, NOW).extraUsage, undefined);
});

test("parseUsagePayload: extra_usage present but off → enabled false, junk numbers dropped", () => {
  const u = parseUsagePayload({ extra_usage: { is_enabled: false, monthly_limit: "100" } }, NOW);
  assert.deepEqual(u.extraUsage, { enabled: false, monthlyLimit: undefined, usedCredits: undefined, utilization: undefined });
});

test("shouldWarmup: never pinged → allowed on both paths", () => {
  __setWarmupStateForTests({});
  assert.equal(shouldWarmup("acct", { now: NOW }), true);
  assert.equal(shouldWarmup("acct", { manual: true, now: NOW }), true);
  __setWarmupStateForTests(null);
});

test("shouldWarmup: auto waits 6 h, a tap waits 10 min", () => {
  __setWarmupStateForTests({ acct: NOW });
  const at = (min) => NOW + min * 60_000;
  assert.equal(shouldWarmup("acct", { now: at(60) }), false, "1 h ago, auto");
  assert.equal(shouldWarmup("acct", { now: at(7 * 60) }), true, "7 h ago, auto");
  assert.equal(shouldWarmup("acct", { manual: true, now: at(5) }), false, "5 min ago, manual");
  assert.equal(shouldWarmup("acct", { manual: true, now: at(20) }), true, "20 min ago, manual");
  assert.equal(shouldWarmup("other", { now: at(60) }), true, "throttle is per account");
  __setWarmupStateForTests(null);
});

test("markWarmupAttempt: stamping blocks the next tap", () => {
  __setWarmupStateForTests({});
  markWarmupAttempt("acct", NOW);
  assert.equal(shouldWarmup("acct", { manual: true, now: NOW + 60_000 }), false);
  assert.equal(shouldWarmup("acct", { manual: true, now: NOW + 11 * 60_000 }), true);
  __setWarmupStateForTests(null);
});

test("warmupAccount: stamps the attempt BEFORE spawning, then succeeds on a clean result", async () => {
  __setWarmupStateForTests({});
  const fake = installFakeQuery();
  try {
    const p = warmupAccount({ name: "acct", configDir: "/Users/x/.claude-acct-x" }, makeCfg());
    await tick();
    assert.equal(shouldWarmup("acct", { manual: true }), false, "a hung ping must not be retryable immediately");
    const opts = fake.latest().args.options;
    assert.equal(opts.persistSession, false, "persistSession:false is what keeps the ping out of /sessions");
    assert.equal(opts.model, "haiku");
    assert.equal(opts.maxTurns, 1);
    assert.equal(opts.cwd, STATE_DIR);
    assert.equal(opts.env.CLAUDE_CONFIG_DIR, "/Users/x/.claude-acct-x");
    assert.equal(opts.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(opts.pathToClaudeCodeExecutable, undefined);
    fake.latest().push(msg.result());
    assert.deepEqual(await p, { ok: true });
  } finally {
    fake.reset();
    __setWarmupStateForTests(null);
  }
});

test("warmupAccount: an auth_status error and a failed turn both return ok:false, never throw", async () => {
  __setWarmupStateForTests({});
  const fake = installFakeQuery();
  try {
    const p1 = warmupAccount({ name: "acct", configDir: null }, makeCfg({ claudeExecutable: "/opt/claude" }));
    await tick();
    assert.equal(fake.latest().args.options.pathToClaudeCodeExecutable, "/opt/claude");
    assert.equal(fake.latest().args.options.env.CLAUDE_CONFIG_DIR, undefined, "the default account gets no override");
    fake.latest().push({ type: "auth_status", isAuthenticating: false, output: [], error: "OAuth token revoked" });
    const r1 = await p1;
    assert.equal(r1.ok, false);
    assert.equal(r1.error, "OAuth token revoked");

    const p2 = warmupAccount({ name: "acct2", configDir: null }, makeCfg());
    await tick();
    fake.latest().push({ type: "result", subtype: "error_during_execution", is_error: true });
    const r2 = await p2;
    assert.equal(r2.ok, false);
    assert.match(r2.error, /error_during_execution/);

    const p3 = warmupAccount({ name: "acct3", configDir: null }, makeCfg());
    await tick();
    fake.latest().throw(new Error("spawn claude ENOENT"));
    const r3 = await p3;
    assert.deepEqual(r3, { ok: false, error: "spawn claude ENOENT" });
  } finally {
    fake.reset();
    __setWarmupStateForTests(null);
  }
});

test("the throttle tests never touched the real bridge-state warmup file", () => {
  const after = fs.existsSync(WARMUP_PATH) ? fs.readFileSync(WARMUP_PATH, "utf8") : null;
  assert.equal(after, realWarmupFile);
});

// --- regressions from the 2026-08-09 adversarial review ---

test("parseUsagePayload: a percentage outside 0-100 is clamped (usageBar's repeat() would throw)", () => {
  assert.equal(parseUsagePayload({ five_hour: { utilization: -5 } }, NOW).fiveHour.pct, 0);
  assert.equal(parseUsagePayload({ five_hour: { utilization: 140 } }, NOW).fiveHour.pct, 100);
  const scoped = parseUsagePayload({
    limits: [{ kind: "weekly_scoped", percent: -3, scope: { model: { display_name: "Fable" } } }],
  }, NOW).scoped;
  assert.equal(scoped[0].win.pct, 0);
});

test("parseUsagePayload: two limits[] entries for the same model collapse to one line", () => {
  const u = parseUsagePayload({
    limits: [
      { kind: "weekly_scoped", percent: 10, scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 20, scope: { model: { display_name: "fable" } } },
    ],
  }, NOW);
  assert.equal(u.scoped.length, 1, "one window per model, not one per entry");
  assert.equal(u.scoped[0].win.pct, 20, "the later entry wins");
});
