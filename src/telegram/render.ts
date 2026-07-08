// Telegram HTML rendering: escaping, light markdown→HTML, chunking.
// HTML parse mode only — MarkdownV2's escaping rules reject LLM output too easily.

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Very light markdown → Telegram HTML. Code fences and inline code become copyable blocks. */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  const parts = md.split(/```/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // fenced code block; first line may be a language tag
      const body = parts[i].replace(/^[a-zA-Z0-9_+-]*\n/, "");
      out.push(`<pre><code>${esc(body)}</code></pre>`);
    } else {
      let t = esc(parts[i]);
      t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
      out.push(t);
    }
  }
  return out.join("");
}

/** Split HTML-ish text into ≤ limit chunks, preferring line boundaries and never
 *  splitting inside a <pre> block (re-opens the tag across chunks instead). */
export function chunk(html: string, limit = 3800): string[] {
  if (html.length <= limit) return [html];
  const chunks: string[] = [];
  let rest = html;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut);
    // keep <pre><code> balanced across the cut
    const opens = (piece.match(/<pre><code>/g) || []).length;
    const closes = (piece.match(/<\/code><\/pre>/g) || []).length;
    if (opens > closes) {
      piece += "</code></pre>";
      rest = "<pre><code>" + rest;
    }
    chunks.push(piece);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

export function fmtPct(p: number | null | undefined): string {
  return p === null || p === undefined ? "?" : `${Math.round(p)}%`;
}

// Absolute times use the Mac's system timezone (this daemon runs on the Mac,
// and the Mac's clock is the user's reference clock).
export function fmtReset(epochSec: number | null | undefined): string {
  if (!epochSec) return "";
  const s = new Date(epochSec * 1000).toLocaleString("en-GB", {
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `resets ${s.replace(",", "")}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}k`;
}

export function fmtAgo(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 60 / 24)}d ago`;
}

/** Compact one-line summary of a tool call for the activity feed. */
export function toolLine(name: string, input: Record<string, unknown>): string {
  const first =
    (input.command as string) ?? (input.file_path as string) ?? (input.path as string) ??
    (input.pattern as string) ?? (input.url as string) ?? (input.prompt as string) ?? "";
  const arg = String(first).replace(/\s+/g, " ").slice(0, 80);
  return `🔧 <b>${esc(name)}</b>${arg ? ` <code>${esc(arg)}</code>` : ""}`;
}
