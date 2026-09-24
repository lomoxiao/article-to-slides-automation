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

test("leaves tables and inline markup untouched unless richText is enabled", () => {
  const markdown = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n**太字** と `コード`";
  const plain = renderReadingEdition({ title: "既定", markdown });

  assert.doesNotMatch(plain, /<table>/);
  assert.doesNotMatch(plain, /<strong>/);
  assert.doesNotMatch(plain, /reader-table/);
  assert.match(plain, /\*\*太字\*\*/);
});

test("renders tables and inline markup when richText is enabled", () => {
  const html = renderReadingEdition({
    title: "表",
    markdown: "| 見出し | 値 |\n| --- | ---: |\n| 行 | 1 |\n\n**太字** と `コード` と [link](https://example.com)",
    features: { richText: true }
  });

  assert.match(html, /<div class="reader-table"><table><thead><tr><th>見出し<\/th>/);
  assert.match(html, /<td style="text-align:right">1<\/td>/);
  assert.match(html, /<strong>太字<\/strong>/);
  assert.match(html, /<code>コード<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/">link<\/a>/);
  assert.match(html, /\.reader-table table/);
});

test("renders tables as nested lists when tableLayout is list", () => {
  const html = renderReadingEdition({
    title: "箇条書き",
    markdown: [
      "| # | 確認対象 | 何を確認するか | 出典 |",
      "| --- | --- | --- | --- |",
      "| 1 | Visa の発表 | 定義 | (出典: a) |",
      "| 2 | 空欄あり |  | (出典: b) |",
      "",
      "| 系統 | 第 1 回 | 差分 |",
      "| --- | --- | --- |",
      "| NetStars | imToken | Kaia へ |"
    ].join("\n"),
    features: { richText: true, tableLayout: "list" }
  });

  assert.doesNotMatch(html, /<table>/);
  assert.match(
    html,
    /<ul class="reader-table-list"><li><strong>1\. Visa の発表<\/strong><ul><li>何を確認するか: 定義<\/li><li>出典: \(出典: a\)<\/li><\/ul><\/li>/
  );
  assert.match(html, /<li><strong>2\. 空欄あり<\/strong><ul><li>出典: \(出典: b\)<\/li><\/ul><\/li>/);
  assert.match(html, /<li><strong>NetStars<\/strong><ul><li>第 1 回: imToken<\/li><li>差分: Kaia へ<\/li><\/ul><\/li>/);
});

test("keeps the table layout by default when richText is enabled", () => {
  const html = renderReadingEdition({
    title: "既定は表",
    markdown: "| a | b |\n| --- | --- |\n| 1 | 2 |",
    features: { richText: true }
  });
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<ul class="reader-table-list">/);
});

test("falls back to a paragraph when a pipe block is not a real table", () => {
  const html = renderReadingEdition({
    title: "表ではない",
    markdown: "| これは表ではありません |\n| 区切り行がない |",
    features: { richText: true }
  });
  assert.doesNotMatch(html, /<table>/);
  assert.match(html, /これは表ではありません/);
});

test("does not let inline links smuggle javascript urls", () => {
  const html = renderReadingEdition({
    title: "リンク",
    markdown: "[危険](javascript:alert(1))",
    features: { richText: true }
  });
  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(html, /javascript:alert\(1\)"/);
});

