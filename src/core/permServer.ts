// Localhost-only HTTP endpoint that the foreign-session PermissionRequest hook calls to ask
// the owner for a permission decision via Telegram. Bound to 127.0.0.1 and gated by a shared
// token (defense-in-depth: authenticate any inbound surface). Never exposed off-box.
import http from "node:http";

export interface ForeignPermRequest {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
}
export interface PermVerdict { decision: "allow" | "deny" | "ask"; reason?: string }
export type PermDecider = (req: ForeignPermRequest) => Promise<PermVerdict>;

export function startPermServer(port: number, token: string, decide: PermDecider): http.Server {
  const server = http.createServer((req, res) => {
    const reply = (v: PermVerdict): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.method !== "POST" || !req.url?.startsWith("/perm")) { res.writeHead(404); res.end(); return; }
    if (token && req.headers["x-bridge-token"] !== token) { res.writeHead(403); res.end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", async () => {
      try {
        const p = JSON.parse(body);
        reply(await decide({
          sessionId: String(p.sessionId ?? ""),
          tool: String(p.tool ?? ""),
          input: (p.input as Record<string, unknown>) ?? {},
          cwd: String(p.cwd ?? ""),
        }));
      } catch { reply({ decision: "ask" }); } // fail safe → normal desktop prompt
    });
  });
  server.on("error", (e) => console.error("permServer error:", (e as Error).message));
  server.listen(port, "127.0.0.1");
  return server;
}
