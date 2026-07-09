// Fixture tests for transcript JSONL parsing (schema-tolerant; must fail soft on junk).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcriptContextPct } from "../dist/core/usage.js";

function withFixture(lines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpct-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("transcriptContextPct: reads the last assistant usage → context % (200k window)", () => {
  withFixture([
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "assistant", isSidechain: false, message: { model: "claude-x", usage: { input_tokens: 50000, cache_read_input_tokens: 50000 } } }),
  ], (file) => {
    const r = transcriptContextPct(file);
    assert.ok(r, "should parse a result");
    assert.equal(r.model, "claude-x");
    assert.ok(Math.abs(r.pct - 50) < 0.001, `expected 50%, got ${r.pct}`); // 100k / 200k
  });
});

test("transcriptContextPct: a [1m]-context model uses the 1M window", () => {
  withFixture([
    JSON.stringify({ type: "assistant", message: { model: "claude-x[1m]", usage: { input_tokens: 250000 } } }),
  ], (file) => {
    const r = transcriptContextPct(file);
    assert.ok(r);
    assert.ok(Math.abs(r.pct - 25) < 0.001, `expected 25%, got ${r.pct}`); // 250k / 1M
  });
});

test("transcriptContextPct: ignores sidechain + malformed lines, uses newest real assistant", () => {
  withFixture([
    "not json at all",
    JSON.stringify({ type: "assistant", isSidechain: true, message: { model: "sub", usage: { input_tokens: 199999 } } }),
    JSON.stringify({ type: "assistant", isSidechain: false, message: { model: "main", usage: { input_tokens: 20000 } } }),
  ], (file) => {
    const r = transcriptContextPct(file);
    assert.ok(r);
    assert.equal(r.model, "main", "must skip the sidechain entry");
    assert.ok(Math.abs(r.pct - 10) < 0.001, `expected 10%, got ${r.pct}`); // 20k / 200k
  });
});

test("transcriptContextPct: missing file returns null (fails soft)", () => {
  assert.equal(transcriptContextPct("/no/such/file.jsonl"), null);
});
