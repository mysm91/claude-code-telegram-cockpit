// Fake-SDK integration: drives a real ManagedSession through Cockpit with a fake query() and a
// fake grammY Api, asserting the lifecycle events reach "Telegram" — no real SDK/network/quota.
// This is the scaffolding the Batch D/H/I tests build on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cockpit } from "../dist/telegram/cockpit.js";
import { makeFakeApi, makeFakeStore, makeCfg, makeRec, installFakeQuery, msg, tick } from "./helpers.mjs";

test("lifecycle: spawn → init → stream text → finish sends the expected Telegram messages", async () => {
  const fake = installFakeQuery();
  try {
    const api = makeFakeApi();
    const cockpit = new Cockpit(api, makeCfg(), makeFakeStore());
    const rec = makeRec();

    const sess = await cockpit.spawn(rec, { firstPrompt: "hello" });
    const inst = fake.latest();
    assert.ok(inst, "fake query instance was created on spawn");
    assert.equal(cockpit.live.get(rec.key), sess, "session is registered in cockpit.live");

    inst.push(msg.init("sess-123", "claude-x"));
    await tick();
    assert.equal(rec.sessionId, "sess-123", "session id captured from the init message");
    assert.equal(rec.model, "claude-x", "model captured from init");

    inst.push(msg.assistantText("final answer"));
    await tick();
    assert.ok(api.texts().some((t) => t.includes("final answer")), "assistant text reached Telegram");
    assert.equal(sess.lastFinalText, "final answer");

    inst.end(); // stream ends → pump completes → onExit("finished")
    await tick();
    assert.equal(rec.status, "closed", "status is closed after a normal finish");
    assert.ok(api.texts().some((t) => t.includes("session ended")), "exit note was sent");
  } finally {
    fake.reset();
  }
});

test("lifecycle: a stream error detaches the session and notes it", async () => {
  const fake = installFakeQuery();
  try {
    const api = makeFakeApi();
    const cockpit = new Cockpit(api, makeCfg(), makeFakeStore());
    const rec = makeRec({ key: "k2" });

    await cockpit.spawn(rec, {});
    const inst = fake.latest();
    inst.push(msg.init());
    await tick();
    inst.throw(new Error("boom"));
    await tick();
    assert.equal(rec.status, "detached", "an SDK error detaches (not closes) the session");
  } finally {
    fake.reset();
  }
});
