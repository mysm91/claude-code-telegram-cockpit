// Pure-function tests for the Telegram HTML renderer (no SDK/network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, esc, mdToHtml } from "../dist/telegram/render.js";

test("chunk: short text stays a single piece", () => {
  assert.deepEqual(chunk("hello"), ["hello"]);
});

test("chunk: long text splits within the limit and is lossless (no <pre>)", () => {
  const html = ("x".repeat(100) + "\n").repeat(100); // ~10.1k chars, plain text
  const pieces = chunk(html, 3800);
  assert.ok(pieces.length > 1, "should split");
  for (const p of pieces) assert.ok(p.length <= 3800 + 32, `piece too long: ${p.length}`);
  assert.equal(pieces.join(""), html, "plain-text chunking must be lossless");
});

test("chunk: keeps <pre><code> balanced across every cut", () => {
  const html = `<pre><code>${"code line\n".repeat(200)}</code></pre>`;
  const pieces = chunk(html, 500);
  assert.ok(pieces.length > 1, "should split");
  for (const p of pieces) {
    const opens = (p.match(/<pre><code>/g) || []).length;
    const closes = (p.match(/<\/code><\/pre>/g) || []).length;
    assert.equal(opens, closes, "each chunk must have balanced <pre><code> tags");
  }
});

test("esc escapes &, <, > (order-safe)", () => {
  assert.equal(esc(`<b>&`), "&lt;b&gt;&amp;");
});

test("mdToHtml converts **bold** and fenced code", () => {
  assert.equal(mdToHtml("**hi**"), "<b>hi</b>");
  assert.ok(mdToHtml("```\ncode\n```").includes("<pre><code>code\n</code></pre>"));
});
