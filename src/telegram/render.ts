// Telegram HTML rendering: escaping, GFM→Telegram-HTML conversion, chunking.
// HTML parse mode only — MarkdownV2's escaping rules reject LLM output too easily.
// The converter may emit ONLY these tags (Telegram's set): b i s code pre a
// blockquote (+ the `expandable` attribute). Anything else Telegram rejects with
// 400 "can't parse entities", which degrades the whole message to plain text.

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** esc() for values interpolated into an attribute — only <a href="…"> today. */
export function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

/** Strip tags, then unescape entities (&amp; LAST) — for the plain-text fallbacks. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// Fences are line-anchored: a mid-line ``` must not flip fence parity.
const FENCE = /^ {0,3}```/;
const DELIM = /^[\s:|-]*-[\s:|-]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const HR = /^ {0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
// Monospace columns wider than this wrap badly on a phone → key-value fallback.
const TABLE_COLS = 40;

/** Emphasis on already-escaped text. Italic carries word-boundary guards so
 *  snake_case identifiers and `3*4` survive. */
const emph = (t: string): string =>
  t
    .replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+?)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+?)~~/g, "<s>$1</s>")
    .replace(/(?<![\w*])\*([^*\n]+?)\*(?![\w*])/g, "<i>$1</i>")
    .replace(/(?<![\w_])_([^_\n]+?)_(?![\w_])/g, "<i>$1</i>");

/** One line of prose → HTML. Code spans and links are lifted out first so
 *  emphasis can never run inside them (a `_` in a URL used to become <i>). */
const renderInline = (raw: string): string => {
  const holds: string[] = [];
  const keep = (html: string): string => `\u0000${holds.push(html) - 1}\u0000`;
  const restore = (s: string): string =>
    s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => restore(holds[Number(n)] ?? ""));
  let t = raw.replace(/`([^`\n]+)`/g, (_m, body: string) => keep(`<code>${esc(body)}</code>`));
  // http(s) only: any other scheme stays literal text (no javascript: links).
  t = t.replace(
    /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) => keep(`<a href="${escAttr(url)}">${emph(esc(label))}</a>`),
  );
  return restore(emph(esc(t)));
};

const stripCell = (s: string): string => s.replace(/`/g, "").replace(/\*\*|__|~~/g, "").trim();

const cellsOf = (row: string): string[] => {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|")) r = r.slice(0, -1);
  return r.split("|").map(stripCell);
};

/** rows = [header, delimiter, ...body]. Column widths use String.length, so
 *  CJK/emoji/RTL cells are only approximately aligned — acceptable here. */
const renderTable = (rows: string[]): string => {
  if (rows.length < 3) return renderInline(rows[0]);
  const parsed = [rows[0], ...rows.slice(2)].map(cellsOf);
  const cols = parsed.reduce((n, r) => Math.max(n, r.length), 0);
  const [head, ...body] = parsed.map((r) => Array.from({ length: cols }, (_v, c) => r[c] ?? ""));
  const widths = Array.from({ length: cols }, (_v, c) =>
    parsed.reduce((w, r) => Math.max(w, (r[c] ?? "").length), 0));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (cols - 1);
  if (total <= TABLE_COLS) {
    const line = (cells: string[]): string =>
      cells.map((v, c) => esc(c === cols - 1 ? v : v.padEnd(widths[c]))).join("   ").trimEnd();
    return `<pre>${[line(head), "─".repeat(total), ...body.map(line)].join("\n")}</pre>`;
  }
  return body
    .map((r) => [
      `<b>${esc(r[0])}</b>`,
      ...r.slice(1).map((v, idx) => `  ${esc(head[idx + 1])}: ${esc(v)}`),
    ].join("\n"))
    .join("\n\n");
};

const renderQuote = (lines: string[]): string => {
  const inner = lines.map((l) => l.replace(QUOTE, ""));
  const big = inner.join("\n").length > 400 || inner.length > 5;
  return `<blockquote${big ? " expandable" : ""}>${inner.map(renderInline).join("\n")}</blockquote>`;
};

/** Line walker. Multi-line constructs collapse into one output element, so the
 *  elements re-join with the original newlines (no paragraph rewrapping). */
const renderLines = (lines: string[]): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      let j = i + 1;
      while (j < lines.length && !FENCE.test(lines[j])) j++;
      // An unterminated fence still renders as code: a truncated stream degrades
      // to a code block, not to soup.
      const inner = lines.slice(i + 1, j);
      if (j >= lines.length && inner[inner.length - 1] === "") inner.pop();
      out.push(`<pre><code>${esc(inner.map((l) => `${l}\n`).join(""))}</code></pre>`);
      i = j + 1;
      continue;
    }
    const next = i + 1 < lines.length ? lines[i + 1] : "";
    if (line.includes("|") && next.includes("|") && DELIM.test(next)) {
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|")) j++;
      out.push(renderTable(lines.slice(i, j)));
      i = j;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const gap = next.trim() === "" ? "" : "\n";
      out.push(`<b>${renderInline(h[2].replace(/\s+#+\s*$/, ""))}</b>${gap}`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push("───");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      let j = i;
      while (j < lines.length && QUOTE.test(lines[j])) j++;
      out.push(renderQuote(lines.slice(i, j)));
      i = j;
      continue;
    }
    const it = ITEM.exec(line);
    if (it) {
      const level = Math.floor(it[1].replace(/\t/g, "  ").length / 2);
      const box = it[3] === undefined ? "" : /[xX]/.test(it[3]) ? "☑ " : "☐ ";
      const marker = /^\d/.test(it[2]) ? it[2].replace(")", ".") : "•";
      out.push(`${"  ".repeat(level)}${marker} ${box}${renderInline(it[4])}`);
      i++;
      continue;
    }
    out.push(renderInline(line));
    i++;
  }
  return out;
};

/** GitHub-flavored markdown → Telegram HTML. Never throws: any internal error
 *  falls back to the escaped source (worst case looks like the old renderer). */
export function mdToHtml(md: string): string {
  try {
    return renderLines(md.replace(/\r\n/g, "\n").split("\n")).join("\n");
  } catch {
    return esc(md);
  }
}

/** Raw-markdown blocks: blank-line separated, a fence always one block.
 *  Lossless — the blocks concatenate back to `md`. */
const splitBlocks = (md: string): string[] => {
  const lines = md.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const blocks: string[] = [];
  let cur = "";
  let fenced = false;
  for (const l of lines) {
    if (FENCE.test(l)) fenced = !fenced;
    cur += l;
    if (!fenced && l.trim() === "") {
      blocks.push(cur);
      cur = "";
    }
  }
  if (cur !== "") blocks.push(cur);
  return blocks;
};

/** Split the MARKDOWN at block boundaries, then convert — so a cut never lands
 *  inside a table, list or fence. A single oversized block falls back to chunk(). */
export function mdToChunks(md: string, limit = 3800): string[] {
  const out: string[] = [];
  let acc = "";
  let html = "";
  const flush = (): void => {
    if (acc !== "") out.push(html);
    acc = "";
    html = "";
  };
  for (const b of splitBlocks(md)) {
    const grown = mdToHtml(acc + b);
    if (grown.length <= limit) {
      acc += b;
      html = grown;
      continue;
    }
    flush();
    const solo = mdToHtml(b);
    if (solo.length <= limit) {
      acc = b;
      html = solo;
      continue;
    }
    for (const p of chunk(solo, limit)) out.push(p);
  }
  flush();
  return out.length ? out : [mdToHtml(md)];
}

const TG_TAGS = new Set(["b", "i", "s", "code", "pre", "a", "blockquote"]);
const TAG_RE = /<(\/?)([a-zA-Z]+)[^>]*>/g;

/** Tags still open at the end of `html`, outermost first (with their attributes). */
const openTags = (html: string): Array<{ name: string; raw: string }> => {
  const stack: Array<{ name: string; raw: string }> = [];
  for (const m of html.matchAll(TAG_RE)) {
    const name = m[2].toLowerCase();
    if (!TG_TAGS.has(name)) continue;
    if (m[1]) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          stack.splice(k, 1);
          break;
        }
      }
    } else stack.push({ name, raw: m[0] });
  }
  return stack;
};

/** Pull a cut back off an unclosed tag or a half-written entity. */
const safeCut = (s: string, cut: number): number => {
  const head = s.slice(0, cut);
  const lt = head.lastIndexOf("<");
  if (lt > head.lastIndexOf(">") && lt > 0) return lt;
  const amp = /&[a-zA-Z#0-9]{0,8}$/.exec(head);
  if (amp && cut - amp[0].length > 0) return cut - amp[0].length;
  return cut;
};

const chooseCut = (s: string, limit: number): number => {
  let cut = s.lastIndexOf("\n", limit);
  if (cut < limit * 0.5) cut = limit;
  return safeCut(s, cut);
};

/** Split HTML text into ≤ limit pieces, preferring line boundaries. Open tags are
 *  closed at the cut and re-opened (with attributes) on the next piece. */
export function chunk(html: string, limit = 3800): string[] {
  if (html.length <= limit) return [html];
  const chunks: string[] = [];
  let rest = html;
  while (rest.length > limit) {
    let cut = chooseCut(rest, limit);
    let open = openTags(rest.slice(0, cut));
    const overhead = open.reduce((n, t) => n + t.name.length + 3, 0);
    if (cut + overhead > limit && cut > overhead) {
      cut = chooseCut(rest, cut - overhead);
      open = openTags(rest.slice(0, cut));
    }
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut);
    if (open.length) {
      piece += open.map((t) => `</${t.name}>`).reverse().join("");
      rest = open.map((t) => t.raw).join("") + rest;
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
