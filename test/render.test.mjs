// Pure-function tests for the Telegram HTML renderer (no SDK/network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, esc, htmlToPlain, mdToChunks, mdToHtml } from "../dist/telegram/render.js";

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

test("chunk: a hard cut never lands inside an entity or a tag", () => {
  const entity = "x".repeat(3798) + "&amp;" + "y".repeat(400);
  const pieces = chunk(entity, 3800);
  assert.ok(pieces.length > 1, "should split");
  for (const p of pieces) {
    assert.ok(!/&[a-zA-Z#0-9]*$/.test(p), `piece ends mid-entity: ${JSON.stringify(p.slice(-8))}`);
  }
  assert.equal(pieces.join(""), entity, "entity-safe cut must stay lossless for plain text");

  const tag = "x".repeat(3799) + "<b>bold</b>" + "y".repeat(400);
  const tagPieces = chunk(tag, 3800);
  for (const p of tagPieces) assert.ok(!p.endsWith("<"), "piece ends mid-tag");
  assert.equal(tagPieces.join(""), tag, "the <b> pair is intact in one piece");
});

test("chunk: closes and re-opens an <i> that spans a cut", () => {
  const html = `<i>${"word ".repeat(200)}</i>`;
  const pieces = chunk(html, 400);
  assert.ok(pieces.length > 2, "should split several times");
  for (const p of pieces) {
    assert.equal((p.match(/<i>/g) || []).length, (p.match(/<\/i>/g) || []).length, `unbalanced: ${p}`);
    assert.ok(p.startsWith("<i>"), `piece must re-open the tag: ${p.slice(0, 12)}`);
  }
  assert.equal(htmlToPlain(pieces.join("")), htmlToPlain(html), "text content survives");
});

test("chunk: re-opens <blockquote expandable> with its attribute", () => {
  const html = `<blockquote expandable>${"quoted line of text\n".repeat(60)}</blockquote>`;
  const pieces = chunk(html, 500);
  assert.ok(pieces.length > 1, "should split");
  for (const p of pieces) {
    assert.equal(
      (p.match(/<blockquote/g) || []).length,
      (p.match(/<\/blockquote>/g) || []).length,
      `unbalanced blockquote: ${p.slice(0, 40)}`,
    );
    assert.ok(p.startsWith("<blockquote expandable>"), `attribute lost: ${p.slice(0, 30)}`);
  }
});

test("mdToChunks: short markdown is one converted piece", () => {
  const md = "# H\n\ntext with **bold**\n\n- a\n- b";
  assert.deepEqual(mdToChunks(md), [mdToHtml(md)]);
});

test("mdToChunks: a fence and a table are never split across pieces", () => {
  const fence = `\`\`\`\n${"code line\n".repeat(20)}\`\`\``;
  const rows = Array.from({ length: 10 }, (_v, i) => `| k${i} | v${i} |`).join("\n");
  const md = ["intro ".repeat(40), fence, `| k | v |\n|---|---|\n${rows}`, "outro ".repeat(40)].join("\n\n");
  const pieces = mdToChunks(md, 600);
  assert.ok(pieces.length > 1, "should split");
  for (const p of pieces) {
    assert.ok(!p.includes("```"), `raw fence markers leaked: ${p.slice(0, 40)}`);
    assert.equal((p.match(/<pre/g) || []).length, (p.match(/<\/pre>/g) || []).length, `unbalanced <pre>: ${p}`);
    assert.ok(p.length <= 632, `piece too long: ${p.length}`);
  }
  const withFence = pieces.filter((p) => p.includes("code line"));
  assert.equal(withFence.length, 1, "the fence stayed in one piece");
  const withTable = pieces.filter((p) => p.includes("k0"));
  assert.equal(withTable.length, 1, "the table stayed in one piece");
  assert.ok(withTable[0].includes("k9"), "the whole table is in that piece");
});

test("mdToChunks: an oversized fence falls back to balanced code pieces", () => {
  const pieces = mdToChunks(`\`\`\`\n${"code line\n".repeat(200)}\`\`\``, 500);
  assert.ok(pieces.length > 1, "should split");
  for (const p of pieces) {
    const opens = (p.match(/<pre><code>/g) || []).length;
    const closes = (p.match(/<\/code><\/pre>/g) || []).length;
    assert.equal(opens, closes, "each piece is a complete code block");
    assert.ok(p.length <= 532, `piece too long: ${p.length}`);
  }
});
