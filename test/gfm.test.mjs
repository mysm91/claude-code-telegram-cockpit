// GFM → Telegram-HTML converter tests (pure functions, no SDK/network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { escAttr, htmlToPlain, mdToHtml } from "../dist/telegram/render.js";

// Telegram accepts exactly these tags; anything else means a 400 and a message
// that degrades to unformatted plain text.
const ALLOWED = /^<\/?(b|i|s|code|pre|blockquote|a)( [^>]*)?>$/;
const assertWhitelist = (html, label) => {
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    assert.match(tag, ALLOWED, `${label}: illegal tag ${tag}`);
  }
};

test("gfm: headings become <b>, blank line only when content follows", () => {
  assert.equal(mdToHtml("# Title"), "<b>Title</b>");
  assert.equal(mdToHtml("###### deep"), "<b>deep</b>");
  assert.equal(mdToHtml("## Closed ##"), "<b>Closed</b>");
  assert.equal(mdToHtml("# Title\ntext"), "<b>Title</b>\n\ntext");
  assert.equal(mdToHtml("# Title\n\ntext"), "<b>Title</b>\n\ntext");
  assert.equal(mdToHtml("# **bold** head"), "<b><b>bold</b> head</b>");
});

test("gfm: bullet, ordered and task lists with 2-space nesting", () => {
  assert.equal(
    mdToHtml("- one\n* two\n  + nested\n    - deeper"),
    "• one\n• two\n  • nested\n    • deeper",
  );
  assert.equal(mdToHtml("1. first\n2) second\n10. tenth"), "1. first\n2. second\n10. tenth");
  assert.equal(mdToHtml("- [x] done\n- [ ] todo\n- [X] also"), "• ☑ done\n• ☐ todo\n• ☑ also");
  assert.equal(mdToHtml("- **bold** item"), "• <b>bold</b> item");
});

test("gfm: blockquote runs collapse, expandable past the threshold", () => {
  assert.equal(mdToHtml("> a\n> b"), "<blockquote>a\nb</blockquote>");
  assert.equal(mdToHtml(">no space"), "<blockquote>no space</blockquote>");
  const five = mdToHtml("> a\n> b\n> c\n> d\n> e");
  assert.ok(five.startsWith("<blockquote>"), `5 lines must not be expandable: ${five}`);
  const six = mdToHtml("> a\n> b\n> c\n> d\n> e\n> f");
  assert.ok(six.startsWith("<blockquote expandable>"), `6 lines must be expandable: ${six}`);
  const long = mdToHtml(`> ${"x".repeat(401)}`);
  assert.ok(long.startsWith("<blockquote expandable>"), "401 chars must be expandable");
  const short = mdToHtml(`> ${"x".repeat(300)}`);
  assert.ok(short.startsWith("<blockquote>"), "300 chars must not be expandable");
  // a quote run ends where the markers end
  assert.equal(mdToHtml("> q\nplain"), "<blockquote>q</blockquote>\nplain");
});

test("gfm: horizontal rules become a line, list items do not", () => {
  assert.equal(mdToHtml("---"), "───");
  assert.equal(mdToHtml("***\n___\n- - -"), "───\n───\n───");
  assert.equal(mdToHtml("- item"), "• item");
});

test("gfm: links are http(s)-only and href-escaped", () => {
  assert.equal(
    mdToHtml("see [docs](https://x.com/a?q=1&z=2)"),
    'see <a href="https://x.com/a?q=1&amp;z=2">docs</a>',
  );
  const quoted = mdToHtml('[t](https://x.com/a")onmouseover=alert(1))');
  assert.ok(!quoted.includes('a"onmouseover'), `quote must be escaped: ${quoted}`);
  assert.ok(quoted.includes("&quot;"), `expected &quot; in ${quoted}`);
  assertWhitelist(quoted, "quoted href");
  // other schemes stay literal text — never a link
  const js = mdToHtml("[bad](javascript:alert(1))");
  assert.ok(!js.includes("<a "), `javascript: must not become a link: ${js}`);
  assert.equal(js, "[bad](javascript:alert(1))");
  assert.ok(!mdToHtml("[f](file:///etc/passwd)").includes("<a "), "file: must not become a link");
  // emphasis must not run inside a URL
  assert.equal(
    mdToHtml("[x](https://x.com/_a_b_)"),
    '<a href="https://x.com/_a_b_">x</a>',
  );
});

test("gfm: emphasis boundaries keep snake_case and 3*4 intact", () => {
  assert.equal(mdToHtml("snake_case_name stays"), "snake_case_name stays");
  assert.equal(mdToHtml("3*4 is 12"), "3*4 is 12");
  assert.equal(mdToHtml("_italic_ and *also*"), "<i>italic</i> and <i>also</i>");
  assert.equal(mdToHtml("**b** __b2__ ~~gone~~"), "<b>b</b> <b>b2</b> <s>gone</s>");
  assert.equal(mdToHtml("a `x_y` b"), "a <code>x_y</code> b");
  // no formatting inside a code span
  assert.equal(mdToHtml("`**raw**`"), "<code>**raw**</code>");
});

test("gfm: narrow table renders as an aligned <pre> block", () => {
  const html = mdToHtml("| name | qty |\n| --- | ---: |\n| apples | 3 |\n| pears | 12 |");
  assert.ok(html.startsWith("<pre>") && html.endsWith("</pre>"), html);
  const rows = html.slice("<pre>".length, -"</pre>".length).split("\n");
  assert.equal(rows[0], "name     qty");
  assert.match(rows[1], /^─+$/);
  assert.equal(rows[2], "apples   3");
  assert.equal(rows[3], "pears    12");
  assertWhitelist(html, "narrow table");
});

test("gfm: wide table falls back to key-value lines outside <pre>", () => {
  const md = [
    "| name | description | owner |",
    "|---|---|---|",
    "| alpha | a description far too wide for a phone | meysam |",
    "| beta | another very long description of things | someone |",
  ].join("\n");
  const html = mdToHtml(md);
  assert.ok(!html.includes("<pre>"), `wide table must not use <pre>: ${html}`);
  assert.ok(html.includes("<b>alpha</b>\n  description: a description far too wide for a phone"), html);
  assert.ok(html.includes("  owner: meysam"), html);
  assert.ok(html.includes("<b>beta</b>"), html);
  assertWhitelist(html, "wide table");
});

test("gfm: table cells lose inline markers, entities are escaped", () => {
  const html = mdToHtml("| a | b |\n|---|---|\n| **x** | `y` & <z> |");
  assert.ok(html.includes("x"), html);
  assert.ok(!html.includes("**") && !html.includes("`"), `markers must be stripped: ${html}`);
  assert.ok(html.includes("&amp;") && html.includes("&lt;z&gt;"), html);
  assertWhitelist(html, "table cells");
});

test("gfm: fences are line-anchored", () => {
  assert.equal(mdToHtml("```\ncode\n```"), "<pre><code>code\n</code></pre>");
  assert.equal(mdToHtml("```js\nlet a = 1;\n```"), "<pre><code>let a = 1;\n</code></pre>");
  // unterminated fence at EOF still renders as code
  const un = mdToHtml("text\n```js\nlet a = 1;\n");
  assert.equal(un, "text\n<pre><code>let a = 1;\n</code></pre>");
  // a mid-line ``` is not a fence
  const mid = mdToHtml("use ```x``` inline");
  assert.ok(!mid.includes("<pre>"), `mid-line fence must not open a block: ${mid}`);
  // markdown inside a fence stays literal
  assert.equal(mdToHtml("```\n# not a heading\n- not a list\n```"),
    "<pre><code># not a heading\n- not a list\n</code></pre>");
  assertWhitelist(un, "unterminated fence");
});

test("gfm: mixed document keeps its line structure", () => {
  const md = "# H\n\ntext\n\n- a\n- b\n\n| k | v |\n|---|---|\n| x | 1 |\n\nend";
  const html = mdToHtml(md);
  assert.ok(html.startsWith("<b>H</b>\n\ntext\n\n• a\n• b\n\n<pre>"), html);
  assert.ok(html.endsWith("</pre>\n\nend"), html);
  assertWhitelist(html, "mixed");
});

test("gfm: never throws and only ever emits whitelisted tags", () => {
  const nasty = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "lone ** and __ and ~~ and * and _",
    "&&&&& &amp &#x27 &lt;",
    "```",
    "```\n```\n```",
    "|".repeat(50) + "\n" + "|---".repeat(50) + "|\n" + "| a ".repeat(50) + "|",
    "> ".repeat(1) + "quote with `code` and [l](https://a.b) and **b**",
    ("> deep quote line\n").repeat(200),
    "- [ ] " + "x".repeat(5000),
    "#".repeat(10) + " heading",
    "\r\n# CRLF heading\r\n- item\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n",
    "[unclosed](https://x.com",
    "`unclosed code",
    "     " .repeat(20) + "- deeply indented",
    "🎉 emoji و فارسی _mixed_ **bold**",
    "",
    "\n\n\n",
  ];
  for (const md of nasty) {
    const html = mdToHtml(md);
    assert.equal(typeof html, "string");
    assertWhitelist(html, JSON.stringify(md.slice(0, 40)));
    assert.ok(!/<script/i.test(html), `raw script survived: ${html.slice(0, 80)}`);
  }
});

test("escAttr escapes quotes on top of esc", () => {
  assert.equal(escAttr('a"b&c<d'), "a&quot;b&amp;c&lt;d");
});

test("htmlToPlain strips tags and unescapes entities (&amp; last)", () => {
  assert.equal(htmlToPlain("<b>a</b> &amp; &lt;b&gt;"), "a & <b>");
  assert.equal(htmlToPlain('<a href="https://x">t</a>'), "t");
  assert.equal(htmlToPlain("&amp;lt;"), "&lt;");
});
