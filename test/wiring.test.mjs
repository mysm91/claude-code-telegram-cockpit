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
