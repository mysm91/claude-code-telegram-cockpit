// Foreign-session observer: tails a session's JSONL transcript and forwards new
// assistant/user entries. Read-only; schema-tolerant (unknown line types ignored).
import fs from "node:fs";

export interface WatchHandle { stop(): void }

export function watchTranscript(
  file: string,
  onEntry: (kind: "user" | "assistant" | "tool", text: string, input?: Record<string, unknown>) => void,
): WatchHandle {
  let offset = 0;
  try { offset = fs.statSync(file).size; } catch { /* starts at 0 */ }
  let buf = "";
  let busy = false;

  const readNew = (): void => {
    if (busy) return;
    busy = true;
    try {
      const st = fs.statSync(file);
      if (st.size < offset) offset = 0; // rotated/truncated
      if (st.size > offset) {
        const fd = fs.openSync(file, "r");
        const len = st.size - offset;
        const b = Buffer.alloc(Math.min(len, 4 * 1024 * 1024));
        const n = fs.readSync(fd, b, 0, b.length, offset);
        fs.closeSync(fd);
        offset += n;
        buf += b.toString("utf8", 0, n);
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.isSidechain) continue;
            if (d.type === "assistant") {
              const content = d.message?.content ?? [];
              const text = (Array.isArray(content) ? content : [])
                .filter((c: { type?: string }) => c.type === "text")
                .map((c: { text?: string }) => c.text ?? "")
                .join("\n");
              if (text.trim()) onEntry("assistant", text);
              for (const c of Array.isArray(content) ? content : []) {
                if (c.type === "tool_use") onEntry("tool", `${c.name}`, (c.input as Record<string, unknown>) ?? {});
              }
            } else if (d.type === "user") {
              const c = d.message?.content;
              const text = typeof c === "string"
                ? c
                : (Array.isArray(c) ? c : []).filter((x: { type?: string }) => x.type === "text").map((x: { text?: string }) => x.text ?? "").join("\n");
              if (text.trim() && !text.startsWith("<")) onEntry("user", text);
            }
          } catch { /* partial/unknown line */ }
        }
      }
    } catch { /* file gone; keep polling until stop() */ }
    busy = false;
  };

  const timer = setInterval(readNew, 2000);
  let watcher: fs.FSWatcher | null = null;
  try { watcher = fs.watch(file, readNew); } catch { /* poll-only */ }

  return {
    stop(): void {
      clearInterval(timer);
      watcher?.close();
    },
  };
}
