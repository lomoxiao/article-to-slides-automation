import path from "node:path";
import { config } from "../../config.js";
import {
  listInboxCandidates,
  replacePlaceholderTitle,
  setInboxSummaryStatus,
  upsertArticleTldr,
  type InboxCandidate,
  type InboxSummaryStatus
} from "../../shared/firebaseArticleStore.js";
import { getOrCreateArticleDigest } from "../bundle/articleDigest.js";
import { ingestArticle } from "../ingest/ingestArticle.js";

/**
 * 受信箱(保存しただけの記事)に、3行要約とタイトルを付ける。
 * 保存の時点ではスライド等を作らないので、「読むか決める」ための材料だけを先に用意する。
 * 一度試した記事は、成功でも失敗でも繰り返さない(失敗の理由は取り込み結果として記事に残る)。
 */
const SUMMARY_KINDS = new Set(["web", "youtube"]);

/** 3行要約を付ける対象を、新しい順に max 件選ぶ。 */
export function selectInboxTargets(candidates: InboxCandidate[], max: number): InboxCandidate[] {
  return candidates
    .filter(
      (article) =>
        !article.deleted &&
        SUMMARY_KINDS.has(article.sourceKind) &&
        article.registeredFrom !== "daily-digest" &&
        !article.hasArtifact &&
        !article.hasTldr &&
        !article.summaryStatus
    )
    .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))
    .slice(0, Math.max(0, max));
}

export type InboxSummarizerDeps = {
  maxPerTick: number;
  jobsRoot: string;
  list: () => Promise<InboxCandidate[]>;
  setStatus: (articleId: string, status: InboxSummaryStatus) => Promise<void>;
  ingest: (url: string) => Promise<{ title: string; text: string }>;
  digest: (input: {
    articleId: string;
    title: string;
    markdown: string;
    jobDir: string;
    requireTldr: boolean;
  }) => Promise<{ tldr?: string[] }>;
  saveTldr: (url: string, tldr: string) => Promise<void>;
  saveTitle: (url: string, title: string) => Promise<unknown>;
  log: (message: string) => void;
};

export function defaultInboxSummarizerDeps(): InboxSummarizerDeps {
  return {
    maxPerTick: config.inbox.summaryMaxPerTick,
    jobsRoot: path.join("jobs", "inbox"),
    list: listInboxCandidates,
    setStatus: setInboxSummaryStatus,
    ingest: async (url) => {
      const source = await ingestArticle(url);
      return { title: source.title, text: source.text };
    },
    digest: (input) => getOrCreateArticleDigest(input),
    saveTldr: upsertArticleTldr,
    saveTitle: replacePlaceholderTitle,
    log: (message) => console.log(`[inbox-summary] ${message}`)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function summarizeInboxArticle(article: InboxCandidate, deps: InboxSummarizerDeps): Promise<InboxSummaryStatus> {
  await deps.setStatus(article.articleId, "processing");
  try {
    // 本文が取れない場合、理由は取り込み工程が記事に書く(Viewer に「本文が取れていません」と出る)
    const source = await deps.ingest(article.canonicalUrl);
    const digest = await deps.digest({
      articleId: article.articleId,
      title: source.title || article.title,
      markdown: source.text,
      jobDir: path.join(deps.jobsRoot, article.articleId),
      requireTldr: true
    });
    if (!digest.tldr || digest.tldr.length !== 3) throw new Error("digest has no tldr");
    await deps.saveTldr(article.canonicalUrl, digest.tldr.map((line) => `- ${line}`).join("\n"));
    if (source.title) await Promise.resolve(deps.saveTitle(article.canonicalUrl, source.title)).catch(() => {});
    await deps.setStatus(article.articleId, "done");
    return "done";
  } catch (error) {
    deps.log(`${article.articleId}: failed: ${errorMessage(error).slice(0, 300)}`);
    await deps.setStatus(article.articleId, "failed").catch(() => {});
    return "failed";
  }
}

export type InboxTickResult = { done: number; failed: number };

let running = false;

/** 1回分の確認。前回がまだ動いていれば何もしない。 */
export async function inboxSummaryTick(deps: InboxSummarizerDeps = defaultInboxSummarizerDeps()): Promise<InboxTickResult | "busy"> {
  if (running) return "busy";
  running = true;
  try {
    const targets = selectInboxTargets(await deps.list(), deps.maxPerTick);
    const result: InboxTickResult = { done: 0, failed: 0 };
    for (const article of targets) {
      const status = await summarizeInboxArticle(article, deps);
      if (status === "done") result.done += 1;
      else result.failed += 1;
    }
    return result;
  } finally {
    running = false;
  }
}

/** 常駐プロセスから呼ぶ。INBOX_SUMMARY_ENABLED が true のときだけ、起動時と一定間隔で確認する。 */
export function startInboxSummarizer(logger: Pick<Console, "log" | "error"> = console): boolean {
  if (!config.inbox.summaryEnabled) return false;
  const tick = () => {
    inboxSummaryTick()
      .then((result) => {
        if (result !== "busy" && result.done + result.failed > 0) {
          logger.log(`[inbox-summary] ${JSON.stringify(result)}`);
        }
      })
      .catch((error) => logger.error(`[inbox-summary] tick failed: ${errorMessage(error)}`));
  };
  tick();
  setInterval(tick, config.inbox.summaryIntervalMin * 60_000);
  logger.log(`[inbox-summary] watching the inbox (every ${config.inbox.summaryIntervalMin} min)`);
  return true;
}
