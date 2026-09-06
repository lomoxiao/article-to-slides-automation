import test from "node:test";
import assert from "node:assert/strict";
import { renderReadingEdition } from "./readingEdition.js";

test("renders a semantic Japanese reading edition with TLDR and source", () => {
  const html = renderReadingEdition({
    title: "夜に読む記事",
    tldr: "- 要点その1\n- 要点その2\n- 要点その3",
    markdown: "# 最初の章\n\n本文です。\n\n- 項目A\n- 項目B",
    sourceUrl: "https://example.com/article?id=1",
    extractedAt: "2026-09-06T22:00:00+09:00"
  });

  assert.match(html, /<html lang="ja">/);
  assert.match(html, /<article data-reader-format="2">/);
  assert.match(html, /<h1>夜に読む記事<\/h1>/);
  assert.match(html, /<h2 id="reader-summary-title">3行要約<\/h2>/);
  assert.match(html, /<li>要点その3<\/li>/);
  assert.match(html, /<h2>最初の章<\/h2>/);
  assert.match(html, /<a href="https:\/\/example\.com\/article\?id=1">元記事を開く<\/a>/);
});

test("escapes untrusted title and markdown instead of executing HTML", () => {
  const html = renderReadingEdition({
    title: "<img src=x onerror=alert(1)>",
    markdown: "<script>alert('xss')</script>\n\n- <b>unsafe</b>",
    tldr: "- <svg onload=alert(1)>"
  });

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=/);
  assert.doesNotMatch(html, /<svg onload=/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("drops unsafe source protocols", () => {
  const html = renderReadingEdition({
    title: "Safe",
    markdown: "本文",
    sourceUrl: "javascript:alert(1)"
  });
  assert.doesNotMatch(html, /<footer class="reader-source">/);
  assert.doesNotMatch(html, /javascript:/);
});

test("renders ordered lists, quotes, and fenced code without raw markup", () => {
  const html = renderReadingEdition({
    title: "構造テスト",
    markdown: "1. 一番\n2. 二番\n\n> 引用\n\n```html\n<strong>code</strong>\n```"
  });
  assert.match(html, /<ol><li>一番<\/li><li>二番<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>引用<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>&lt;strong&gt;code&lt;\/strong&gt;<\/code><\/pre>/);
});

test("groups consecutive quote lines into one readable quote block", () => {
  const html = renderReadingEdition({
    title: "引用",
    markdown: "> 1行目\n> 2行目\n> 3行目"
  });

  assert.match(
    html,
    /<blockquote><p>1行目<br>2行目<br>3行目<\/p><\/blockquote>/
  );
});

test("limits TLDR to three non-empty items", () => {
  const html = renderReadingEdition({
    title: "要約テスト",
    markdown: "本文",
    tldr: "- 1\n\n- 2\n- 3\n- 4"
  });
  assert.match(html, /<li>3<\/li>/);
  assert.doesNotMatch(html, /<li>4<\/li>/);
});
