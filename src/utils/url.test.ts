import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, extractFirstUrl, isPublicHttpUrl, sanitizeArticleUrl } from "./url.js";
import { normalizeUrl } from "./slackArgTokens.js";

test("&amp; を & に戻す", () => {
  assert.equal(
    sanitizeArticleUrl("https://m.youtube.com/watch?v=0dIW2HVFv3w&amp;t=285s&amp;ra=m"),
    "https://m.youtube.com/watch?v=0dIW2HVFv3w&t=285s&ra=m"
  );
});

test("末尾の > と句読点を除く", () => {
  assert.equal(
    sanitizeArticleUrl("https://zenn.dev/libercraft/articles/20260501-finetuning-vs-rag>"),
    "https://zenn.dev/libercraft/articles/20260501-finetuning-vs-rag"
  );
  assert.equal(sanitizeArticleUrl("https://example.com/a。"), "https://example.com/a");
});

test("英数字に連結された末尾の日本語を除く", () => {
  assert.equal(
    sanitizeArticleUrl("https://note.com/x402inc/n/nb266051df2bcグラフを"),
    "https://note.com/x402inc/n/nb266051df2bc"
  );
});

test("区切り文字の直後から始まる日本語パスは残す", () => {
  assert.equal(sanitizeArticleUrl("https://ja.wikipedia.org/wiki/東京"), "https://ja.wikipedia.org/wiki/東京");
  assert.equal(sanitizeArticleUrl("https://example.com/search?q=量子"), "https://example.com/search?q=量子");
});

test("正常なURLは変えない", () => {
  for (const url of [
    "https://www.businesswire.com/news/home/20260618161261/ja",
    "https://arxiv.org/html/2608.05435v1",
    "https://example.com/path/?a=1&b=2#frag"
  ]) {
    assert.equal(sanitizeArticleUrl(url), url);
  }
});

test("Slack 引数の normalizeUrl にも掃除が効く", () => {
  assert.equal(normalizeUrl("<https://example.com/a?x=1&amp;y=2>"), "https://example.com/a?x=1&y=2");
  assert.equal(normalizeUrl("https://note.com/u/n/nabc123グラフを"), "https://note.com/u/n/nabc123");
});

test("extractFirstUrl は掃除済みのURLを返す", () => {
  assert.equal(extractFirstUrl("見て https://example.com/a?x=1&amp;y=2 です"), "https://example.com/a?x=1&y=2");
});

test("公開URLチェック: 通常の http(s) URL は通す", () => {
  for (const url of [
    "https://note.com/x/n/n123",
    "http://example.com/a?b=1",
    "https://ja.wikipedia.org/wiki/東京",
    "https://8.8.8.8/dns",
    "https://172.32.0.1/public"
  ]) {
    assert.equal(isPublicHttpUrl(url), true, url);
  }
});

test("公開URLチェック: 内部宛て・http(s)以外・不正な形式は拒否する", () => {
  for (const url of [
    "http://localhost:3000/health",
    "http://127.0.0.1/",
    "http://10.0.0.5/admin",
    "http://172.16.1.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://nas/share",
    "http://printer.local/",
    "http://db.internal/",
    "file:///C:/Windows/win.ini",
    "ftp://example.com/a",
    "javascript:alert(1)",
    "これはURLではない"
  ]) {
    assert.equal(isPublicHttpUrl(url), false, url);
  }
  assert.equal(isPublicHttpUrl(`https://example.com/${"a".repeat(2100)}`), false);
});

test("公開URLチェック: 拒否理由は利用者向けの文になる", () => {
  assert.throws(() => assertPublicHttpUrl("http://192.168.1.1/"), /内部ネットワーク/);
  assert.throws(() => assertPublicHttpUrl("ftp://example.com/"), /http/);
});
