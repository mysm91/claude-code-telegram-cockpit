// Pure-function tests for the voice module. No network, no gemini/edge-tts/ffmpeg spawns:
// transcribe()/synthesize() are exercised by the cockpit integration suite through the
// __setSynthesizeForTests seam, never for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { audioExt, hasPersian, parseGeminiJson, resolveVoice, speechText } from "../dist/core/voice.js";

test("hasPersian: letters decide, digits do not", () => {
  assert.equal(hasPersian("سلام، حالت چطوره؟"), true);
  assert.equal(hasPersian("deploy is green"), false);
  assert.equal(hasPersian("the tests سبز شدند"), true);
  // Persian (۰-۹) and Arabic-Indic (٠-٩) digits live inside the Arabic block, but an otherwise
  // English line that quotes them must still be spoken by the English voice.
  assert.equal(hasPersian("passed ۳ of ۵ checks"), false);
  assert.equal(hasPersian("build ٧ failed"), false);
  assert.equal(hasPersian("42 tests, 0 failures!"), false);
  assert.equal(hasPersian(""), false);
});

test("speechText: drops code fences entirely", () => {
  const { text } = speechText("before\n```js\nconst x = 1;\n```\nafter", 2000);
  assert.ok(!text.includes("const x"), `fence body leaked: ${text}`);
  assert.ok(text.includes("before") && text.includes("after"));
});

test("speechText: keeps inline code content without backticks", () => {
  const { text } = speechText("run `npm test` now", 2000);
  assert.equal(text, "run npm test now");
});

test("speechText: drops table rows and separators", () => {
  const md = "Results:\n| col | val |\n|---|---|\n| a | 1 |\n---|---\ndone";
  const { text } = speechText(md, 2000);
  assert.equal(text, "Results:\ndone");
});

test("speechText: links keep the label, bare URLs go", () => {
  const { text } = speechText("see [the docs](https://example.com/a?b=c) or https://example.com/raw here", 2000);
  assert.equal(text, "see the docs or  here");
});

test("speechText: strips emphasis, headings, bullets, quotes and extra blank lines", () => {
  const md = "## Heading\n\n\n\n- **bold** item\n* second\n> quoted _line_";
  const { text } = speechText(md, 2000);
  assert.equal(text, "Heading\n\nbold item\nsecond\nquoted line");
});

test("speechText: caps at the last word boundary and reports truncation", () => {
  const { text, truncated } = speechText("alpha beta gamma delta", 12);
  assert.equal(truncated, true);
  assert.equal(text, "alpha beta");
  assert.ok(text.length <= 12);
});

test("speechText: capping never leaves half an emoji", () => {
  // An odd cap lands between the surrogates of "😀"; a lone surrogate would reach edge-tts
  // and the Telegram caption.
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const cap of [11, 12, 13, 51]) {
    const { text } = speechText("😀".repeat(100), cap);
    assert.ok(!lone.test(text), `cap ${cap} produced a lone surrogate`);
  }
});

test("speechText: no truncation flag when it fits", () => {
  assert.deepEqual(speechText("short one", 2000), { text: "short one", truncated: false });
});

test("speechText: code-only reply speaks nothing", () => {
  assert.deepEqual(speechText("```\nonly code\n```", 2000), { text: "", truncated: false });
});

test("parseGeminiJson: clean JSON", () => {
  assert.equal(parseGeminiJson('{"response":"سلام دنیا"}'), "سلام دنیا");
});

test("parseGeminiJson: JSON after a log preamble, trimmed", () => {
  const out = 'Loaded cached credentials.\nData collection is disabled.\n{"response":"  hello there \\n"}\n';
  assert.equal(parseGeminiJson(out), "hello there");
});

test("parseGeminiJson: garbage / missing / non-string / empty response → null", () => {
  assert.equal(parseGeminiJson("command not found: gemini"), null);
  assert.equal(parseGeminiJson(""), null);
  assert.equal(parseGeminiJson('{"stats":{"tokens":10}}'), null);
  assert.equal(parseGeminiJson('{"response":{"text":"hi"}}'), null);
  assert.equal(parseGeminiJson('{"response":42}'), null);
  assert.equal(parseGeminiJson('{"response":"   "}'), null);
});

test("resolveVoice: full defaults when config has no voice block", () => {
  assert.deepEqual(resolveVoice({}), {
    googleCloudProject: undefined,
    sttModel: "gemini-2.5-pro",
    sttMaxDurationSec: 300,
    sttMaxBytes: 19 * 1024 * 1024,
    sttTimeoutMs: 120_000,
    replies: "auto",
    uvxPath: "uvx",
    faVoice: "fa-IR-DilaraNeural",
    enVoice: "en-US-AriaNeural",
    ttsMaxChars: 2500,
    ttsTimeoutMs: 60_000,
  });
});

test("resolveVoice: a partial voice block keeps every other default (shallow-spread trap)", () => {
  const vs = resolveVoice({ voice: { replies: "off", uvxPath: "/opt/bin/uvx" } });
  assert.equal(vs.replies, "off");
  assert.equal(vs.uvxPath, "/opt/bin/uvx");
  assert.equal(vs.sttModel, "gemini-2.5-pro");
  assert.equal(vs.faVoice, "fa-IR-DilaraNeural");
  assert.equal(vs.ttsMaxChars, 2500);
  assert.equal(vs.sttTimeoutMs, 120_000);
});

test("resolveVoice: zero is an explicit override, not a missing value", () => {
  assert.equal(resolveVoice({ voice: { sttMaxDurationSec: 0 } }).sttMaxDurationSec, 0);
});

test("audioExt: allowlisted extensions win, mime types map, anything else is null", () => {
  assert.equal(audioExt("memo.OGG", undefined), ".ogg");
  assert.equal(audioExt("memo.oga", undefined), ".oga");
  assert.equal(audioExt("song.mp3", "audio/mpeg"), ".mp3");
  assert.equal(audioExt("clip.wav", undefined), ".wav");
  assert.equal(audioExt("clip.flac", undefined), ".flac");
  assert.equal(audioExt("clip.aac", undefined), ".aac");
  assert.equal(audioExt("memo.m4a", undefined), ".m4a");
  assert.equal(audioExt(undefined, "audio/ogg"), ".ogg");
  assert.equal(audioExt(undefined, "audio/mpeg; codecs=mp3"), ".mp3");
  assert.equal(audioExt("recording", "audio/x-m4a"), ".m4a");
  assert.equal(audioExt("note.opus", undefined), null);
  assert.equal(audioExt("track.wma", "audio/x-ms-wma"), null);
  assert.equal(audioExt(undefined, undefined), null);
});
