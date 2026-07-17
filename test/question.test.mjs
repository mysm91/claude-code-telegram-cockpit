// AskUserQuestion (finding #12): all 1-4 questions must render, multi-select must toggle, and
// the answers object must key by question text. Covers the cockpit render + keyboard layers;
// the Telegram tap flow itself is exercised on-device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cockpit } from "../dist/telegram/cockpit.js";
import { makeFakeApi, makeFakeStore, makeCfg, makeRec, installFakeQuery, msg, tick } from "./helpers.mjs";

const QUESTIONS = [
  { question: "Which fruits?", header: "Fruits", multiSelect: true,
    options: [{ label: "Apple", description: "red" }, { label: "Banana", description: "yellow" }] },
  { question: "Which size?", header: "Size", multiSelect: false,
    options: [{ label: "Small", description: "" }, { label: "Large", description: "" }] },
];

async function setup() {
  const fake = installFakeQuery();
  const api = makeFakeApi();
  const cockpit = new Cockpit(api, makeCfg({ approvalTimeoutMin: 5 }), makeFakeStore());
  const rec = makeRec({ key: "kq" });
  await cockpit.spawn(rec, {});
  const inst = fake.latest();
  inst.push(msg.init());
  await tick();
  const decision = inst.args.options.canUseTool("AskUserQuestion", { questions: QUESTIONS }, { signal: new AbortController().signal });
  await tick(20);
  return { fake, api, cockpit, decision };
}

test("#12: renders ALL questions with their options (not just the first)", async () => {
  const { fake, api, cockpit } = await setup();
  try {
    const prompt = api.texts().find((t) => t.includes("Which fruits?"));
    assert.ok(prompt, "question prompt was sent");
    assert.ok(prompt.includes("Which size?"), "second question rendered too");
    assert.ok(prompt.includes("Apple") && prompt.includes("Large"), "options of both questions rendered");
    assert.ok(prompt.includes("2 questions"), "header counts the questions");
    const [a] = [...cockpit.approvals.values()];
    a.resolve({ behavior: "deny", message: "test cleanup" });
  } finally { fake.reset(); }
});

test("#12: keyboard has per-question toggle buttons, per-question Other, and one Submit", async () => {
  const { fake, api, cockpit } = await setup();
  try {
    const sent = api.sent().find((c) => c.args.text.includes("Which fruits?"));
    const rows = sent.args.extra.reply_markup.inline_keyboard.flat();
    const datas = rows.map((b) => b.callback_data);
    const [a] = [...cockpit.approvals.values()];
    assert.ok(datas.includes(`q:${a.id}:0:0`) && datas.includes(`q:${a.id}:0:1`), "Q1 option buttons");
    assert.ok(datas.includes(`q:${a.id}:1:0`) && datas.includes(`q:${a.id}:1:1`), "Q2 option buttons");
    assert.ok(datas.includes(`q:${a.id}:0:o`) && datas.includes(`q:${a.id}:1:o`), "per-question Other buttons");
    assert.equal(datas.filter((d) => d === `q:${a.id}:submit`).length, 1, "exactly one Submit");
    a.resolve({ behavior: "deny", message: "test cleanup" });
  } finally { fake.reset(); }
});

test("#12: multi-select options and a free-text 'Other' COEXIST (the bug fix); single-question fast path has no Submit", async () => {
  const { fake, cockpit } = await setup();
  try {
    const [a] = [...cockpit.approvals.values()];
    // Q1 (multi-select): options 0 AND 1 picked AND a typed "other" — all three ticked at once.
    const sel = new Map([[0, { opts: new Set([0, 1]), other: "kiwi" }], [1, { opts: new Set(), other: "free text answer" }]]);
    const kb = cockpit.questionKb(a, sel).inline_keyboard.flat();
    const label = (data) => kb.find((b) => b.callback_data === data)?.text ?? "";
    assert.ok(label(`q:${a.id}:0:0`).includes("✅"), "picked option 0 shows ✅");
    assert.ok(label(`q:${a.id}:0:1`).includes("✅"), "picked option 1 shows ✅");
    assert.ok(label(`q:${a.id}:0:o`).includes("✅"), "free-text coexists → Other also ✅ (was the bug)");
    assert.ok(label(`q:${a.id}:1:o`).includes("✅"), "Q2 free-text marks Other ✅");
    // Single single-select question → instant mode: no submit, no toggle prefixes
    const single = { ...a, input: { questions: [QUESTIONS[1]] } };
    const kb2 = cockpit.questionKb(single, new Map()).inline_keyboard.flat();
    assert.ok(!kb2.some((b) => b.callback_data.endsWith(":submit")), "no Submit in instant mode");
    a.resolve({ behavior: "deny", message: "test cleanup" });
  } finally { fake.reset(); }
});
