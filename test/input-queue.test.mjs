// Per-thread input ordering (telegram/inputQueue).
//
// Detaching the message handlers is what keeps the bot answering /stop and approval taps while a
// 20–120 s transcription runs — but it also removes the ordering that grammY's sequential update
// loop used to provide for free. These tests pin the replacement: same-thread messages stay in
// order (voice AND text, since a typed message must not overtake a voice note sent before it),
// different threads run concurrently, and one failure does not strand the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInputQueue } from "../dist/telegram/inputQueue.js";

const defer = () => { let resolve, reject; const p = new Promise((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };
const noop = () => {};

test("inputQueue: a slow job holds later jobs on the SAME thread, in order", async () => {
  const q = createInputQueue();
  const order = [];
  const slow = defer();

  const a = q.run("chat:1", async () => { order.push("voice-start"); await slow.p; order.push("voice-end"); }, noop);
  const b = q.run("chat:1", async () => { order.push("text"); }, noop);

  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["voice-start"], "the typed message must not overtake the voice note");
  assert.equal(q.busy("chat:1"), true, "the thread reports busy while work is outstanding");

  slow.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["voice-start", "voice-end", "text"], "strict FIFO within a thread");
  assert.equal(q.busy("chat:1"), false, "the entry is dropped once the chain drains");
  assert.equal(q.size(), 0, "no chain is left behind");
});

test("inputQueue: a different thread is NOT blocked by a slow job", async () => {
  const q = createInputQueue();
  const order = [];
  const slow = defer();

  const a = q.run("chat:1", async () => { await slow.p; order.push("thread-1"); }, noop);
  const b = q.run("chat:2", async () => { order.push("thread-2"); }, noop);

  await b;
  assert.deepEqual(order, ["thread-2"], "thread 2 completed while thread 1 was still transcribing");
  assert.equal(q.busy("chat:1"), true);
  assert.equal(q.busy("chat:2"), false);

  slow.resolve();
  await a;
  assert.deepEqual(order, ["thread-2", "thread-1"]);
});

test("inputQueue: a failing job is reported and does NOT strand the thread", async () => {
  const q = createInputQueue();
  const order = [];
  const seen = [];

  const a = q.run("chat:1", async () => { throw new Error("transcription blew up"); }, (e) => { seen.push(e.message); });
  const b = q.run("chat:1", async () => { order.push("next-message"); }, noop);

  await Promise.all([a, b]);
  assert.deepEqual(seen, ["transcription blew up"], "the detached rejection is surfaced, not swallowed");
  assert.deepEqual(order, ["next-message"], "the message after a failure still runs");
  assert.equal(q.busy("chat:1"), false, "the chain is not left permanently busy");
});

test("inputQueue: a synchronously-throwing job is caught too", async () => {
  const q = createInputQueue();
  const seen = [];
  await q.run("chat:1", () => { throw new Error("sync boom"); }, (e) => { seen.push(e.message); });
  assert.deepEqual(seen, ["sync boom"]);
  assert.equal(q.busy("chat:1"), false);
});

test("inputQueue: busy() is what tells the user a voice note was queued", async () => {
  const q = createInputQueue();
  const slow = defer();
  assert.equal(q.busy("chat:1"), false, "an idle thread must not claim to be queued");
  const a = q.run("chat:1", async () => { await slow.p; }, noop);
  assert.equal(q.busy("chat:1"), true, "busy immediately, not one tick later");
  slow.resolve();
  await a;
  assert.equal(q.busy("chat:1"), false);
});

test("inputQueue: many messages on one thread all run, in order", async () => {
  const q = createInputQueue();
  const order = [];
  const jobs = [];
  for (let i = 0; i < 25; i++) jobs.push(q.run("chat:1", async () => { await new Promise((r) => setTimeout(r, 1)); order.push(i); }, noop));
  await Promise.all(jobs);
  assert.deepEqual(order, [...Array(25).keys()], "no message is dropped or reordered under load");
  assert.equal(q.size(), 0);
});
