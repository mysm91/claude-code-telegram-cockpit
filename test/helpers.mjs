// Test harness helpers: a fake Claude Agent SDK query() and a fake grammY Api, so the session
// lifecycle (spawn / stream / permission / exit) can be driven with zero real SDK, network, or
// Telegram traffic. Tests import compiled modules from ../dist (run `npx tsc` first).
import { __setQueryForTests } from "../dist/core/sessionManager.js";

/** Fake grammY Api: records every call; returns incrementing message ids. */
export function makeFakeApi() {
  const calls = [];
  let mid = 1000;
  const rec = (method, args) => calls.push({ method, args });
  return {
    calls,
    sent: () => calls.filter((c) => c.method === "sendMessage"),
    edits: () => calls.filter((c) => c.method === "editMessageText"),
    texts: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.args.text),
    async sendMessage(chatId, text, extra) { rec("sendMessage", { chatId, text, extra }); return { message_id: ++mid }; },
    async editMessageText(chatId, msgId, text, extra) { rec("editMessageText", { chatId, msgId, text, extra }); return { message_id: msgId }; },
    async createForumTopic(chatId, name) { rec("createForumTopic", { chatId, name }); return { message_thread_id: ++mid }; },
    async deleteMessage() {},
    async answerCallbackQuery() {},
  };
}

/** Minimal Store that never touches disk. */
export function makeFakeStore() {
  const sessions = new Map();
  return {
    sessions,
    groups: {},
    flushSessions() {},
    flushGroups() {},
    byTopic(t) { for (const s of sessions.values()) if (s.topicId === t && s.status !== "closed") return s; },
    newKey() { return Math.random().toString(36).slice(2, 8); },
  };
}

/** Minimal BridgeConfig. */
export function makeCfg(over = {}) {
  return {
    accounts: [{ name: "acct", configDir: null }],
    activeAccount: "acct",
    defaults: { mode: "default" },
    usageWarnPct: 90,
    chatId: 42,
    forumMode: false,
    ...over,
  };
}

/** SessionRec builder. */
export function makeRec(over = {}) {
  return {
    key: "k1", cwd: "/tmp/x", account: "acct", mode: "default",
    status: "idle", kind: "managed", createdAt: 1, lastActivityAt: 1,
    ...over,
  };
}

/** Install a fake query() into sessionManager. Each session spawn creates a controllable
 *  instance: `.push(sdkMessage)` feeds the pump, `.end()` ends the stream (→ onExit "finished"),
 *  `.throw(err)` makes the stream reject (→ onExit detached). `latest()` is the newest instance. */
export function installFakeQuery() {
  const instances = [];
  __setQueryForTests((args) => {
    const buf = [];
    let waiter = null, done = false, err = null;
    const wake = () => {
      if (!waiter) return;
      const w = waiter; waiter = null;
      if (err) w.reject(err);
      else if (buf.length) w.resolve({ value: buf.shift(), done: false });
      else if (done) w.resolve({ value: undefined, done: true });
      else waiter = w;
    };
    const inst = {
      args,
      push(m) { buf.push(m); wake(); },
      end() { done = true; wake(); },
      throw(e) { err = e; wake(); },
      q: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
              if (err) return Promise.reject(err);
              if (done) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
            },
          };
        },
        async getContextUsage() { return null; },
        async setPermissionMode() {},
        async setModel() {},
        async interrupt() {},
        async applyFlagSettings() {},
        async accountInfo() { return null; },
        async supportedModels() { return []; },
      },
    };
    instances.push(inst);
    return inst.q;
  });
  return { instances, latest: () => instances[instances.length - 1], reset: () => __setQueryForTests(null) };
}

/** SDK message builders (only the fields the pump reads). */
export const msg = {
  init: (session_id = "sess-uuid", model = "claude-x") => ({ type: "system", subtype: "init", session_id, model }),
  assistantText: (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  toolUse: (name, input = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }),
  result: (subtype = "success") => ({ type: "result", subtype, is_error: false, num_turns: 1 }),
};

/** Let queued microtasks + short timers run. */
export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
