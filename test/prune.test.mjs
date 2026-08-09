// The gemini CLI keeps its own copy of each exchange — the base64 audio AND the transcript — in a
// per-cwd project dir under ~/.gemini/tmp, which deleting our own tmpdir does not touch. transcribe()
// therefore prunes it. That code runs `rm -rf` under $HOME, so both directions are pinned here:
// our own residue must go, and nothing else may be touched (an empty .project_root once matched
// everything). $HOME and $PATH are redirected and a stub stands in for the CLI, so no real gemini
// call, no network, and the real ~/.gemini is never read.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tg-prune-home-"));
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "tg-prune-bin-"));
const geminiDir = path.join(home, ".gemini", "tmp");
fs.mkdirSync(geminiDir, { recursive: true });

// Stands in for `gemini`: records its physical cwd the way the real CLI does, then answers.
fs.writeFileSync(
  path.join(bin, "gemini"),
  `#!/bin/sh\nd="$HOME/.gemini/tmp/stub-project"\nmkdir -p "$d/chats"\npwd -P > "$d/.project_root"\necho '{"audio":"..."}' > "$d/chats/session.jsonl"\necho '{"response":"stub transcript"}'\n`,
  { mode: 0o755 },
);

process.env.HOME = home;
process.env.PATH = `${bin}:${process.env.PATH}`;

const { resolveVoice, transcribe } = await import("../dist/core/voice.js");

// Unrelated project dirs, including the shapes that a substring match would have swallowed.
const planted = {
  realproject: "/Users/someone/Codes/project",
  empty_root: "",
  whitespace_root: "   \n",
  slash_root: "/",
};
for (const [name, owner] of Object.entries(planted)) {
  fs.mkdirSync(path.join(geminiDir, name, "chats"), { recursive: true });
  fs.writeFileSync(path.join(geminiDir, name, "chats", "session.jsonl"), "keep me");
  fs.writeFileSync(path.join(geminiDir, name, ".project_root"), owner);
}

test("transcribe prunes the CLI's copy of the audio and transcript, and nothing else", async () => {
  const r = await transcribe(Buffer.from("fake audio"), ".ogg", resolveVoice({}));
  assert.equal(r.ok, true, `the stub CLI should have answered: ${JSON.stringify(r)}`);
  assert.equal(r.text, "stub transcript");

  const left = fs.readdirSync(geminiDir).sort();
  assert.ok(!left.includes("stub-project"), "the CLI's copy of the voice note must be gone");
  for (const name of Object.keys(planted)) {
    assert.ok(left.includes(name), `${name} is not ours and must survive (its .project_root is ${JSON.stringify(planted[name])})`);
    assert.equal(fs.readFileSync(path.join(geminiDir, name, "chats", "session.jsonl"), "utf8"), "keep me");
  }
  assert.equal(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("tg-voice-")).length, 0, "our own tmpdir must be removed too");
});
