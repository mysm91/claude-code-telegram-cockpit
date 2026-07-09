// Security tests for the away-mode localhost permission endpoint: token auth (constant-time,
// empty-token rejection) and the concurrency cap. Real HTTP round-trips on an ephemeral port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startPermServer } from "../dist/core/permServer.js";

async function listen(server) {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  return server.address().port;
}
function post(port, token, body) {
  const headers = { "content-type": "application/json" };
  if (token !== undefined) headers["x-bridge-token"] = token;
  return fetch(`http://127.0.0.1:${port}/perm`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
}

test("permServer: correct token → decider runs", async () => {
  const server = startPermServer(0, "s3cr3t-token", async (req) => ({ decision: "allow", reason: req.tool }));
  const port = await listen(server);
  try {
    const res = await post(port, "s3cr3t-token", { tool: "Bash", cwd: "/x", input: {}, sessionId: "s" });
    assert.equal(res.status, 200);
    const v = await res.json();
    assert.equal(v.decision, "allow");
    assert.equal(v.reason, "Bash");
  } finally { server.close(); }
});

test("permServer: wrong token → 403", async () => {
  const server = startPermServer(0, "right", async () => ({ decision: "allow" }));
  const port = await listen(server);
  try {
    assert.equal((await post(port, "wrong", {})).status, 403);
  } finally { server.close(); }
});

test("permServer: missing token header → 403", async () => {
  const server = startPermServer(0, "right", async () => ({ decision: "allow" }));
  const port = await listen(server);
  try {
    assert.equal((await post(port, undefined, {})).status, 403);
  } finally { server.close(); }
});

test("permServer: empty configured token → every request 403 (never unauthenticated)", async () => {
  const server = startPermServer(0, "", async () => ({ decision: "allow" }));
  const port = await listen(server);
  try {
    assert.equal((await post(port, "", {})).status, 403);
    assert.equal((await post(port, "anything", {})).status, 403);
  } finally { server.close(); }
});

test("permServer: concurrency cap sheds load to 'ask' under a burst", async () => {
  let release;
  const barrier = new Promise((r) => { release = r; });
  const server = startPermServer(0, "tok", async () => { await barrier; return { decision: "allow" }; });
  const port = await listen(server);
  try {
    const reqs = Array.from({ length: 20 }, () => post(port, "tok", {}).then((r) => r.json()));
    await new Promise((r) => setTimeout(r, 150)); // let them fill the in-flight slots
    release();
    const results = await Promise.all(reqs);
    const asks = results.filter((v) => v.decision === "ask").length;
    assert.ok(asks >= 1, `expected the cap to shed some load, got asks=${asks}`);
    assert.ok(results.every((v) => v.decision === "allow" || v.decision === "ask"));
  } finally { server.close(); }
});
