// Registration-order invariant, checked against the source text.
//
// grammY runs middleware in registration order, and the message:text handler returns early for
// every unrecognised slash command without calling next(). Any bot.command() declared AFTER it is
// therefore dead: tapping it in Telegram does nothing at all, silently. That is exactly how
// /voice shipped unreachable, so the order is asserted rather than remembered.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "telegram", "bot.ts"),
  "utf8",
);

test("EVERY registered command sits before the message:text handler", () => {
  const textAt = src.indexOf('bot.on("message:text"');
  assert.ok(textAt > 0, "the text handler must exist");

  const registered = [...src.matchAll(/bot\.command\("([a-z]+)"/g)];
  assert.ok(registered.length > 25, `expected the full command set, found ${registered.length}`);
  for (const m of registered) {
    assert.ok(m.index < textAt, `/${m[1]} is registered after the message:text handler, so it is unreachable`);
  }
});

test("every command advertised in setMyCommands is actually registered", () => {
  const menu = src.slice(src.indexOf("setMyCommands("));
  const advertised = [...menu.matchAll(/\{ command: "([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(advertised.length > 10, `expected a full command menu, found ${advertised.length}`);
  for (const name of advertised) {
    assert.ok(src.includes(`bot.command("${name}"`), `/${name} is advertised in the menu but never registered`);
  }
});

test("every message handler that feeds a session goes through the input queue", () => {
  // Detaching the handlers is what keeps the bot answering while a transcription runs, but it
  // also means ordering is no longer free. A handler that forgets queueInput() can let a typed
  // message overtake a voice note sent before it — invisible until it bites, so it is asserted.
  for (const kind of ["text", "photo", "voice", "audio"]) {
    const at = src.indexOf(`bot.on("message:${kind}"`);
    assert.ok(at > 0, `the message:${kind} handler must exist`);
    // Bound the body at the NEXT handler: a fixed-size window bleeds into the following one and
    // passes on ITS queueInput call, which is how the first version of this test let a
    // deliberately-bypassed voice handler through.
    const nextAt = src.indexOf('bot.on("message:', at + 10);
    const body = src.slice(at, nextAt > at ? nextAt : src.length);
    assert.ok(body.includes("queueInput("), `message:${kind} does not go through queueInput — it can overtake earlier input`);
  }
});

test("the session-input handlers are detached, not awaited by grammY", () => {
  // If message:text goes back to `async (ctx) =>`, grammY awaits it again and one voice note
  // freezes the whole bot for up to two minutes — no /stop, no approval taps. That regression
  // reads as a harmless refactor, so it is pinned here.
  const at = src.indexOf('bot.on("message:text"');
  assert.ok(!/bot\.on\("message:text",\s*async/.test(src.slice(at, at + 60)),
    "message:text is awaited by grammY again — a transcription will block every other update");
});
