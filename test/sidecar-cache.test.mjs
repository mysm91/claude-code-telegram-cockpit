// The sidecar facts cache (inventory.readSidecarFacts). /sessions re-read every local_*.json on
// every call — measured at 380 MB and 4.8 s of blocked event loop on a real machine. The cache
// keys on (mtime, size) and stores only the six fields listLocalSessions reads, never the parsed
// document: those 380 MB reduce to 0.84 MB of facts, and the daemon stays up for weeks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSidecarFacts } from "../dist/core/inventory.js";

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tg-sidecar-"));

/** Count reads of a specific path while fn() runs. inventory.ts does `import fs from "node:fs"`,
 *  so it holds the same mutable module object this test patches. */
const countReads = (target, fn) => {
  const orig = fs.readFileSync;
  let n = 0;
  fs.readFileSync = (p, ...rest) => { if (String(p) === target) n++; return orig(p, ...rest); };
  try { fn(); } finally { fs.readFileSync = orig; }
  return n;
};

test("readSidecarFacts: extracts the six fields and re-reads only when the file changes", () => {
  const dir = mkTmp();
  const file = path.join(dir, "local_a.json");
  fs.writeFileSync(file, JSON.stringify({
    cliSessionId: "sid-1", cwd: "/tmp/proj", title: "  My session  ",
    lastActivityAt: 1700000000000, isArchived: true, blob: "x".repeat(5000),
  }));

  const first = readSidecarFacts(file);
  assert.equal(first.sid, "sid-1");
  assert.equal(first.cwd, "/tmp/proj");
  assert.equal(first.title, "My session", "title is trimmed");
  assert.equal(first.ts, 1700000000000);
  assert.equal(first.archived, true);
  assert.equal(first.scheduled, false);
  assert.equal(Object.keys(first).length, 6, `only the six facts are kept: ${Object.keys(first)}`);

  // A second call must not touch the disk content at all.
  const reads = countReads(file, () => {
    const again = readSidecarFacts(file);
    assert.equal(again, first, "cache hit returns the very same object");
  });
  assert.equal(reads, 0, "an unchanged sidecar is never re-read");

  // A changed sidecar must be re-read — mtime AND size both move here.
  fs.writeFileSync(file, JSON.stringify({ sessionId: "sid-2", originCwd: "/tmp/other" }));
  const after = countReads(file, () => {
    const changed = readSidecarFacts(file);
    assert.equal(changed.sid, "sid-2", "fallback key cliSessionId → sessionId");
    assert.equal(changed.cwd, "/tmp/other", "fallback key cwd → originCwd");
    assert.equal(changed.archived, false);
  });
  assert.equal(after, 1, "a changed sidecar is re-read exactly once");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("readSidecarFacts: a corrupt sidecar is negative-cached, not re-read every call", () => {
  const dir = mkTmp();
  const file = path.join(dir, "local_bad.json");
  fs.writeFileSync(file, "{ this is not json");

  assert.equal(readSidecarFacts(file), null, "corrupt parses to null");
  const reads = countReads(file, () => {
    assert.equal(readSidecarFacts(file), null);
    assert.equal(readSidecarFacts(file), null);
  });
  assert.equal(reads, 0, "a corrupt sidecar is not re-read on every /sessions");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("readSidecarFacts: a scheduled-task run is flagged, and a vanished file returns null", () => {
  const dir = mkTmp();
  const file = path.join(dir, "local_sched.json");
  fs.writeFileSync(file, JSON.stringify({ scheduledTaskId: "t1", cliSessionId: "sid-3", cwd: "/x" }));
  assert.equal(readSidecarFacts(file).scheduled, true, "scheduled runs stay identifiable");

  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(readSidecarFacts(file), null, "a deleted sidecar returns null rather than a stale hit");
});

test("readSidecarFacts: a same-size edit is still caught (size alone would miss it)", () => {
  const dir = mkTmp();
  const file = path.join(dir, "local_same.json");
  fs.writeFileSync(file, JSON.stringify({ cliSessionId: "aaaaa", cwd: "/p" }));
  assert.equal(readSidecarFacts(file).sid, "aaaaa");
  // identical byte length, different content — only the mtime half of the key can catch this.
  // The mtime is set explicitly: two writes can otherwise land in the same tick on a fast disk,
  // which would make this pass for the wrong reason (or flake).
  fs.writeFileSync(file, JSON.stringify({ cliSessionId: "bbbbb", cwd: "/p" }));
  const t = fs.statSync(file);
  fs.utimesSync(file, t.atime, new Date(t.mtimeMs + 5000));
  assert.equal(readSidecarFacts(file).sid, "bbbbb", "mtime change invalidates a same-size edit");
  fs.rmSync(dir, { recursive: true, force: true });
});
