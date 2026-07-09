// Fake-SDK verification of review findings #4 (dead session must leave cockpit.live) and
// #8 (managed permission prompts must not hang — timeout + delivery-failure fail-safe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cockpit } from "../dist/telegram/cockpit.js";
import { makeFakeApi, makeFakeStore, makeCfg, makeRec, installFakeQuery, msg, tick } from "./helpers.mjs";

test("#4: a dead session is removed from cockpit.live on normal exit", async () => {
  const fake = installFakeQuery();
  try {
    const cockpit = new Cockpit(makeFakeApi(), makeCfg(), makeFakeStore());
    const rec = makeRec({ key: "kd", sessionId: "sess-1" });
    const sess = await cockpit.spawn(rec, {});
    assert.equal(cockpit.live.get(rec.key), sess, "session is registered in live");
    fake.latest().push(msg.init("sess-1"));
    await tick();
    fake.latest().end(); // normal finish → onExit
    await tick();
    assert.equal(cockpit.live.has(rec.key), false, "dead session must NOT linger in live (was the #4 leak)");
  } finally { fake.reset(); }
});

test("#4: a session that errors is removed from cockpit.live", async () => {
  const fake = installFakeQuery();
  try {
    const cockpit = new Cockpit(makeFakeApi(), makeCfg(), makeFakeStore());
    const rec = makeRec({ key: "kd2", sessionId: "sess-2" });
    await cockpit.spawn(rec, {});
    fake.latest().push(msg.init("sess-2"));
    await tick();
    fake.latest().throw(new Error("boom"));
    await tick();
    assert.equal(cockpit.live.has(rec.key), false, "errored session must leave live too");
  } finally { fake.reset(); }
});

test("#8: an unanswered permission prompt auto-denies after the timeout", async () => {
  const fake = installFakeQuery();
  try {
    const api = makeFakeApi();
    const cockpit = new Cockpit(api, makeCfg({ approvalTimeoutMin: 0.003 }), makeFakeStore()); // ~180ms
    const rec = makeRec({ key: "kh" });
    await cockpit.spawn(rec, {});
    const inst = fake.latest();
    inst.push(msg.init());
    await tick();
    // Simulate the SDK asking for permission (what canUseTool does in prod).
    const decision = inst.args.options.canUseTool("Bash", { command: "rm -rf /" }, { signal: new AbortController().signal });
    await tick(20);
    assert.ok(api.texts().some((t) => /Bash|wants to use/.test(t)), "a permission prompt was sent to Telegram");
    const result = await decision; // nobody taps → resolves via the timeout
    assert.equal(result.behavior, "deny");
    assert.match(result.message, /timed out/i);
  } finally { fake.reset(); }
});

test("#8: a permission prompt that can't reach Telegram fails safe immediately", async () => {
  const fake = installFakeQuery();
  try {
    const cockpit = new Cockpit(makeFakeApi(), makeCfg({ chatId: undefined }), makeFakeStore()); // no chat → say() returns undefined
    const rec = makeRec({ key: "kh2" });
    await cockpit.spawn(rec, {});
    const inst = fake.latest();
    inst.push(msg.init());
    await tick();
    const result = await inst.args.options.canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal });
    assert.equal(result.behavior, "deny");
    assert.match(result.message, /deliver|couldn't/i);
  } finally { fake.reset(); }
});

test("#8: a tapped answer cancels the timeout (no late override)", async () => {
  const fake = installFakeQuery();
  try {
    const cockpit = new Cockpit(makeFakeApi(), makeCfg({ approvalTimeoutMin: 0.003 }), makeFakeStore());
    const rec = makeRec({ key: "kh3" });
    await cockpit.spawn(rec, {});
    const inst = fake.latest();
    inst.push(msg.init());
    await tick();
    const decision = inst.args.options.canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal });
    await tick(10);
    // Simulate the user tapping "Allow" — resolve the pending approval directly.
    const [a] = [...cockpit.approvals.values()];
    a.resolve({ behavior: "allow" });
    const result = await decision;
    assert.equal(result.behavior, "allow", "the tapped answer wins");
    await tick(220); // let the (now-cleared) timeout window pass; must not flip to deny
    assert.equal(result.behavior, "allow");
  } finally { fake.reset(); }
});
