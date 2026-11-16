import test from "node:test";
import assert from "node:assert/strict";
import type { StoredArticleSource, ArticleIngestState } from "../../shared/firebaseArticleStore.js";
import { SourceUnavailableError } from "../../shared/sourceErrors.js";
import type { SourceContent } from "../../types/content.js";
import { ingestArticle, ingestMultiple, isReusable, type IngestDeps } from "./ingestArticle.js";

const NOW = Date.parse("2026-11-16T09:00:00+09:00");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function stored(overrides: Partial<StoredArticleSource> = {}): StoredArticleSource {
  return {
    markdown: "保存済みの本文".repeat(100),
    extractedAt: hoursAgo(1),
    formatVersion: 2,
    formatMethod: "readability_html",
    quality: { verdict: "full", chars: 700 },
    title: "保存済みの記事",
    ...overrides
  };
}

function fetched(url: string, verdict: "full" | "partial" = "full"): SourceContent {
  return {
    url,
    title: "取得した記事",
    text: "取得した本文".repeat(200),
    readerFormatVersion: 2,
    readerFormatMethod: "readability_html",
    quality: { verdict, chars: 1200, reasons: verdict === "partial" ? ["too_short"] : [] }
  };
}

function setup(options: { stored?: StoredArticleSource; reuseHours?: number; fetchError?: Error; verdict?: "full" | "partial" } = {}) {
  const calls = { fetch: [] as string[], saved: [] as string[], states: [] as Array<{ url: string; state: ArticleIngestState }> };
  const deps: IngestDeps = {
    reuseHours: options.reuseHours ?? 24,
    now: () => NOW,
    fetch: async (url) => {
      calls.fetch.push(url);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (options.fetchError) throw options.fetchError;
      return fetched(url, options.verdict);
    },
    loadStored: async () => options.stored,
    saveSource: async (url) => {
      calls.saved.push(url);
    },
    saveState: async (url, state) => {
      calls.states.push({ url, state });
    },
    log: () => {}
  };
  return { deps, calls };
}

test("保存済み本文が無ければ取得して保存し、取り込み状態を記録する", async () => {
  const { deps, calls } = setup();
  const result = await ingestArticle("https://example.com/a", {}, deps);

  assert.equal(result.reused, false);
  assert.equal(result.title, "取得した記事");
  assert.match(result.articleId, /^url_[0-9a-f]{12}$/);
  assert.deepEqual(calls.fetch, ["https://example.com/a"]);
  assert.deepEqual(calls.saved, ["https://example.com/a"]);
  assert.deepEqual(calls.states.map((entry) => entry.state.verdict), ["full"]);
});

test("再利用期間内の全文なら、外部サイトへ行かずに保存済み本文を返す", async () => {
  const { deps, calls } = setup({ stored: stored() });
  const result = await ingestArticle("https://example.com/a", {}, deps);

  assert.equal(result.reused, true);
  assert.equal(result.title, "保存済みの記事");
  assert.equal(result.text, stored().markdown);
  assert.deepEqual(calls.fetch, []);
  assert.deepEqual(calls.saved, []);
});

test("再利用期間を過ぎていれば取り直す。期限なし(0)なら古くても再利用する", async () => {
  const old = stored({ extractedAt: hoursAgo(25) });
  const expired = setup({ stored: old });
  assert.equal((await ingestArticle("https://example.com/a", {}, expired.deps)).reused, false);
  assert.equal(expired.calls.fetch.length, 1);

  const forever = setup({ stored: stored({ extractedAt: hoursAgo(24 * 365) }), reuseHours: 0 });
  assert.equal((await ingestArticle("https://example.com/a", {}, forever.deps)).reused, true);
  assert.equal(forever.calls.fetch.length, 0);
});

test("一部のみ・判定なし・タイトルなしの保存済み本文は再利用しない", () => {
  assert.equal(isReusable(stored(), NOW, 24), true);
  assert.equal(isReusable(stored({ quality: { verdict: "partial", chars: 300 } }), NOW, 24), false);
  assert.equal(isReusable(stored({ quality: undefined }), NOW, 24), false);
  assert.equal(isReusable(stored({ title: undefined }), NOW, 24), false);
  assert.equal(isReusable(stored({ extractedAt: undefined }), NOW, 24), false);
  assert.equal(isReusable(stored({ extractedAt: undefined }), NOW, 0), true);
  assert.equal(isReusable(undefined, NOW, 24), false);
});

test("force を付けると保存済み本文があっても取り直す", async () => {
  const { deps, calls } = setup({ stored: stored() });
  const result = await ingestArticle("https://example.com/a", { force: true }, deps);
  assert.equal(result.reused, false);
  assert.equal(calls.fetch.length, 1);
});

test("取れなかった場合は失敗の状態を記録して SourceUnavailableError を投げ直す。本文は保存しない", async () => {
  const error = new SourceUnavailableError("https://example.com/a", "http_403", "本文が取れていません（サイトに取得を拒否されました）。");
  const { deps, calls } = setup({ fetchError: error });

  await assert.rejects(ingestArticle("https://example.com/a", {}, deps), (thrown) => thrown === error);
  assert.deepEqual(calls.saved, []);
  assert.equal(calls.states[0]?.state.verdict, "failed");
  assert.match(calls.states[0]?.state.message ?? "", /本文が取れていません/);
});

test("判定が一部のときは生成を続け、状態を partial として記録する", async () => {
  const { deps, calls } = setup({ verdict: "partial" });
  const result = await ingestArticle("https://example.com/a", {}, deps);
  assert.equal(result.quality?.verdict, "partial");
  assert.equal(calls.states[0]?.state.verdict, "partial");
  assert.equal(calls.saved.length, 1);
});

test("同じ記事への同時の取り込みは1回にまとめる", async () => {
  const { deps, calls } = setup();
  const [first, second] = await Promise.all([
    ingestArticle("https://example.com/same?utm_source=x", {}, deps),
    ingestArticle("https://example.com/same", {}, deps)
  ]);
  assert.equal(calls.fetch.length, 1);
  assert.equal(first.articleId, second.articleId);
});

test("内部ネットワーク宛てのURLは取りに行かず、取れない扱いにする", async () => {
  const { deps, calls } = setup();
  await assert.rejects(
    ingestArticle("http://192.168.1.10/admin", {}, deps),
    (error: Error & { reason?: string }) => error.name === "SourceUnavailableError" && error.reason === "blocked_url"
  );
  assert.deepEqual(calls.fetch, []);
});

test("テキスト投入の記事は、期間に関係なく保存済み本文を使う。無ければ取れない扱い", async () => {
  const withSource = setup({ stored: stored({ extractedAt: hoursAgo(9999), quality: undefined, title: undefined }) });
  const result = await ingestArticle("text:txt_0123456789ab", {}, withSource.deps);
  assert.equal(result.reused, true);
  assert.equal(withSource.calls.fetch.length, 0);

  const without = setup();
  await assert.rejects(ingestArticle("text:txt_0123456789ab", {}, without.deps), /保存済みの本文がありません/);
  assert.equal(without.calls.fetch.length, 0);
});

test("取得前にURLを掃除する", async () => {
  const { deps, calls } = setup();
  await ingestArticle("https://example.com/a?x=1&amp;y=2>", {}, deps);
  assert.deepEqual(calls.fetch, ["https://example.com/a?x=1&y=2"]);
});

test("複数URL: 記事ごとに取り込み、1本でも取れなければどのURLかを示して止める", async () => {
  const ok = setup();
  const merged = await ingestMultiple(["https://example.com/a", "https://example.com/b"], ok.deps);
  assert.equal(merged.sources.length, 2);
  assert.deepEqual(ok.calls.saved.sort(), ["https://example.com/a", "https://example.com/b"]);

  const error = new SourceUnavailableError("https://example.com/b", "timeout", "本文が取れていません（時間切れ）。");
  const ng = setup({ fetchError: error });
  await assert.rejects(ingestMultiple(["https://example.com/b"], ng.deps), /対象: https:\/\/example\.com\/b/);
});
