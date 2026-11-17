import test from "node:test";
import assert from "node:assert/strict";
import type { InboxCandidate, InboxSummaryStatus } from "../../shared/firebaseArticleStore.js";
import { inboxSummaryTick, selectInboxTargets, summarizeInboxArticle, type InboxSummarizerDeps } from "./inboxSummarizer.js";

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
  ...overrides
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
      candidate("url_tried", { summaryStatus: "failed" }),
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

function setup(options: { ingestFails?: string[]; noTldr?: boolean; candidates?: InboxCandidate[] } = {}) {
  const calls = { status: [] as string[], tldr: [] as string[], titles: [] as string[], digests: [] as string[] };
  const deps: InboxSummarizerDeps = {
    maxPerTick: 3,
    jobsRoot: "jobs/inbox-test",
    list: async () => options.candidates ?? [],
    setStatus: async (articleId: string, status: InboxSummaryStatus) => {
      calls.status.push(`${articleId}:${status}`);
    },
    ingest: async (url) => {
      if (options.ingestFails?.some((id) => url.endsWith(id))) {
        throw new Error("本文が取れていません（サイトに取得を拒否されました）。");
      }
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
  assert.deepEqual(calls.status, ["url_a:processing", "url_a:done"]);
  assert.deepEqual(calls.tldr, ["- 何の話か\n- 何が新しいか\n- 結論"]);
  assert.deepEqual(calls.titles, ["取得したタイトル"]);
  assert.deepEqual(calls.digests, ["url_a:true"]);
});

test("受信箱の要約: 本文が取れない・要約が作れない場合は failed にして、次へ進む(繰り返さない)", async () => {
  const blocked = setup({ ingestFails: ["url_a"] });
  assert.equal(await summarizeInboxArticle(candidate("url_a"), blocked.deps), "failed");
  assert.deepEqual(blocked.calls.status, ["url_a:processing", "url_a:failed"]);
  assert.equal(blocked.calls.tldr.length, 0);

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
  assert.deepEqual(result, { done: 2, failed: 1 });
  assert.equal(calls.status.filter((line) => line.endsWith(":processing")).length, 3);
});
