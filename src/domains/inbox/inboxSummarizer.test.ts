import test from "node:test";
import assert from "node:assert/strict";
import type { InboxCandidate, InboxSummaryStatus } from "../../shared/firebaseArticleStore.js";
import { SourceUnavailableError } from "../../shared/sourceErrors.js";
import {
  MAX_SUMMARY_ATTEMPTS,
  inboxSummaryTick,
  selectInboxTargets,
  summarizeInboxArticle,
  type InboxSummarizerDeps
} from "./inboxSummarizer.js";

const candidate = (articleId: string, overrides: Partial<InboxCandidate> = {}): InboxCandidate => ({
  articleId,
  canonicalUrl: `https://example.com/${articleId}`,
  title: "example.com",
  sourceKind: "web",
  registeredFrom: "shortcut",
  registeredAt: "2026-11-17T08:00:00+09:00",
  deleted: false,
  hasArtifact: false,
  hasTldr: false,
  summaryStatus: "",
  summaryAttempts: 0,
  ...overrides
});

test("受信箱の対象: 一時的な失敗は上限回数まで再試行し、本文が取れない記事は再試行しない", () => {
  const targets = selectInboxTargets(
    [
      candidate("url_retry", { summaryStatus: "failed", summaryAttempts: 1 }),
      candidate("url_old_failed", { summaryStatus: "failed" }),
      candidate("url_gave_up", { summaryStatus: "failed", summaryAttempts: MAX_SUMMARY_ATTEMPTS }),
      candidate("url_unavailable", { summaryStatus: "unavailable", summaryAttempts: 1 }),
      candidate("url_done", { summaryStatus: "done", summaryAttempts: 1 })
    ],
    10
  );
  assert.deepEqual(targets.map((article) => article.articleId).sort(), ["url_old_failed", "url_retry"]);
});

test("受信箱の対象: 保存しただけで、まだ要約を試していない記事だけ。新しい順に上限まで", () => {
  const targets = selectInboxTargets(
    [
      candidate("url_old", { registeredAt: "2026-11-15T08:00:00+09:00" }),
      candidate("url_new", { registeredAt: "2026-11-17T09:00:00+09:00" }),
      candidate("yt_mid", { sourceKind: "youtube", registeredAt: "2026-11-16T08:00:00+09:00" }),
      candidate("url_deleted", { deleted: true }),
      candidate("url_generated", { hasArtifact: true }),
      candidate("url_has_tldr", { hasTldr: true }),
      candidate("url_tried", { summaryStatus: "unavailable" }),
      candidate("url_running", { summaryStatus: "processing" }),
      candidate("txt_text", { sourceKind: "text" }),
      candidate("bnd_bundle", { sourceKind: "bundle" }),
      candidate("txt_digest", { registeredFrom: "daily-digest" })
    ],
    2
  );
  assert.deepEqual(targets.map((article) => article.articleId), ["url_new", "yt_mid"]);
  assert.deepEqual(selectInboxTargets([candidate("url_a")], 0), []);
});

function setup(
  options: { ingestFails?: string[]; ingestBroken?: string[]; noTldr?: boolean; candidates?: InboxCandidate[] } = {}
) {
  const calls = { status: [] as string[], tldr: [] as string[], titles: [] as string[], digests: [] as string[], dirs: [] as string[] };
  const deps: InboxSummarizerDeps = {
    maxPerTick: 3,
    jobsRoot: "jobs/inbox-test",
    list: async () => options.candidates ?? [],
    setStatus: async (articleId: string, status: InboxSummaryStatus, extra?: { attempts?: number }) => {
      calls.status.push(`${articleId}:${status}:${extra?.attempts ?? "-"}`);
    },
    ensureDir: async (dir) => {
      calls.dirs.push(dir);
    },
    ingest: async (url) => {
      if (options.ingestFails?.some((id) => url.endsWith(id))) {
        throw new SourceUnavailableError(url, "http_403", "本文が取れていません（サイトに取得を拒否されました）。");
      }
      if (options.ingestBroken?.some((id) => url.endsWith(id))) throw new Error("network timeout");
      return { title: "取得したタイトル", text: "本文" };
    },
    digest: async (input) => {
      calls.digests.push(`${input.articleId}:${input.requireTldr}`);
      return options.noTldr ? {} : { tldr: ["何の話か", "何が新しいか", "結論"] };
    },
    saveTldr: async (_url, tldr) => {
      calls.tldr.push(tldr);
    },
    saveTitle: async (_url, title) => {
      calls.titles.push(title);
    },
    log: () => {}
  };
  return { deps, calls };
}

test("受信箱の要約: 本文を取り、3行要約とタイトルを付けて done にする", async () => {
  const { deps, calls } = setup();
  assert.equal(await summarizeInboxArticle(candidate("url_a"), deps), "done");
  assert.deepEqual(calls.status, ["url_a:processing:1", "url_a:done:-"]);
  // AI 実行の前に作業フォルダを作る
  assert.deepEqual(calls.dirs, ["jobs/inbox-test/url_a"]);
  assert.deepEqual(calls.tldr, ["- 何の話か\n- 何が新しいか\n- 結論"]);
  assert.deepEqual(calls.titles, ["取得したタイトル"]);
  assert.deepEqual(calls.digests, ["url_a:true"]);
});

test("受信箱の要約: 本文が取れない場合は unavailable、それ以外の失敗は failed(回数を記録)", async () => {
  const blocked = setup({ ingestFails: ["url_a"] });
  assert.equal(await summarizeInboxArticle(candidate("url_a"), blocked.deps), "unavailable");
  assert.deepEqual(blocked.calls.status, ["url_a:processing:1", "url_a:unavailable:1"]);
  assert.equal(blocked.calls.tldr.length, 0);

  const broken = setup({ ingestBroken: ["url_a"] });
  assert.equal(await summarizeInboxArticle(candidate("url_a", { summaryStatus: "failed", summaryAttempts: 1 }), broken.deps), "failed");
  assert.deepEqual(broken.calls.status, ["url_a:processing:2", "url_a:failed:2"]);

  const noTldr = setup({ noTldr: true });
  assert.equal(await summarizeInboxArticle(candidate("url_a"), noTldr.deps), "failed");
});

test("受信箱の確認: 対象を上限まで順に処理し、結果の件数を返す", async () => {
  const { deps, calls } = setup({
    ingestFails: ["url_b"],
    candidates: [candidate("url_a"), candidate("url_b"), candidate("url_c"), candidate("url_d")]
  });
  deps.maxPerTick = 3;
  const result = await inboxSummaryTick(deps);
  assert.deepEqual(result, { done: 2, failed: 0, unavailable: 1 });
  assert.equal(calls.status.filter((line) => line.includes(":processing:")).length, 3);
});
