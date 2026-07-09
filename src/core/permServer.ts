// Localhost-only HTTP endpoint that the foreign-session PermissionRequest hook calls to ask
// the owner for a permission decision via Telegram. Bound to 127.0.0.1 and gated by a shared
// token (defense-in-depth: authenticate any inbound surface). Never exposed off-box.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

export interface ForeignPermRequest {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
}
export interface PermVerdict { decision: "allow" | "deny" | "ask"; reason?: string }
export type PermDecider = (req: ForeignPermRequest) => Promise<PermVerdict>;

/** Constant-time token check. An empty configured token, a missing/empty header, or a length
 *  mismatch all fail — this endpoint is never served unauthenticated. */
function tokenOk(expected: string, got: unknown): boolean {
  if (!expected || typeof got !== "string" || got.length === 0) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal-length buffers
  return timingSafeEqual(a, b);
}

/** Cap simultaneous in-flight decisions so a burst of foreign prompts can't fan out unbounded
 *  Telegram messages / blocking waits. Over the cap → fail safe to the desktop prompt. */
const MAX_INFLIGHT = 8;

export function startPermServer(port: number, token: string, decide: PermDecider): http.Server {
  let inflight = 0;
  const server = http.createServer((req, res) => {
    const reply = (v: PermVerdict): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.method !== "POST" || !req.url?.startsWith("/perm")) { res.writeHead(404); res.end(); return; }
    if (!tokenOk(token, req.headers["x-bridge-token"])) { res.writeHead(403); res.end(); return; }
    if (inflight >= MAX_INFLIGHT) { req.resume(); reply({ decision: "ask" }); return; }
    let body = "";
    let tooBig = false;
    req.on("data", (c) => { body += c; if (body.length > 1_000_000) { tooBig = true; req.destroy(); } });
    req.on("end", async () => {
      if (tooBig) return;
      let p: Record<string, unknown>;
      try { p = JSON.parse(body); } catch { reply({ decision: "ask" }); return; } // fail safe
      inflight++;
      try {
        reply(await decide({
          sessionId: String(p.sessionId ?? ""),
          tool: String(p.tool ?? ""),
          input: (p.input as Record<string, unknown>) ?? {},
          cwd: String(p.cwd ?? ""),
        }));
      } catch { reply({ decision: "ask" }); } // fail safe → normal desktop prompt
      finally { inflight--; }
    });
  });
  server.on("error", (e) => console.error("permServer error:", (e as Error).message));
  // Bound the time to RECEIVE a request (headers + body). The decide() wait for a Telegram tap
  // (~110s) runs after the request is fully received, so it is not capped by these.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.listen(port, "127.0.0.1");
  return server;
}
