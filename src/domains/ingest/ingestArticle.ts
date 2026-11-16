import { config } from "../../config.js";
import {
  getArticleSource,
  upsertArticleIngest,
  upsertArticleSource,
  type ArticleIngestState,
  type StoredArticleSource
} from "../../shared/firebaseArticleStore.js";
import { createArticleIdentity, isSyntheticArticleUrl } from "../../shared/identity.js";
import { fetchSourceContent, mergeSources, type MergedSourceContent } from "../../shared/sourceAggregator.js";
import { SourceUnavailableError, isSourceUnavailableError } from "../../shared/sourceErrors.js";
import type { SourceContent } from "../../types/content.js";
import { assertPublicHttpUrl, sanitizeArticleUrl } from "../../utils/url.js";

/**
 * 取り込み工程。URL を受けたら本文を1回だけ取得して保存し、生成(スライド・漫画・動画・Reader)は
 * ここが返す本文だけを使う。
 *
 * - 保存済み本文が再利用期間内で「全文」なら、外部サイトへ行かずにそれを返す。
 * - 取れなかった場合は SourceUnavailableError(段階1の関門)。記事の取り込み状態にも記録する。
 * - 同じ記事への取り込みが同時に呼ばれたら1回にまとめる。
 */
export type IngestResult = SourceContent & {
  articleId: string;
  /** 保存済み本文を再利用したか(true のとき外部サイトへは行っていない)。 */
  reused: boolean;
};

export type IngestDeps = {
  /** 再利用期間(時間)。0 は期限なし。 */
  reuseHours: number;
  now: () => number;
  fetch: (url: string) => Promise<SourceContent>;
  loadStored: (url: string) => Promise<StoredArticleSource | undefined>;
  saveSource: (url: string, source: SourceContent) => Promise<void>;
  saveState: (url: string, state: ArticleIngestState) => Promise<unknown>;
  log: (message: string) => void;
};

function defaultDeps(): IngestDeps {
  return {
    reuseHours: config.ingest.reuseHours,
    now: () => Date.now(),
    fetch: (url) => fetchSourceContent(url),
    loadStored: getArticleSource,
    saveSource: (url, source) =>
      upsertArticleSource(url, source.text, {
        version: source.readerFormatVersion,
        method: source.readerFormatMethod,
        quality: source.quality,
        title: source.title
      }),
    saveState: upsertArticleIngest,
    log: (message) => console.log(`[ingest] ${message}`)
  };
}

const inFlight = new Map<string, Promise<IngestResult>>();

/** 保存済み本文を再利用してよいか。全文判定で、期間内(または期限なし)のものだけ。 */
export function isReusable(stored: StoredArticleSource | undefined, nowMs: number, reuseHours: number): boolean {
  if (!stored?.markdown || !stored.title) return false;
  if (stored.quality?.verdict !== "full") return false;
  if (reuseHours === 0) return true;
  const extractedMs = stored.extractedAt ? Date.parse(stored.extractedAt) : NaN;
  if (!Number.isFinite(extractedMs)) return false;
  return nowMs - extractedMs <= reuseHours * 3_600_000;
}

function fromStored(url: string, articleId: string, stored: StoredArticleSource): IngestResult {
  return {
    articleId,
    url,
    title: stored.title ?? url,
    text: stored.markdown,
    readerFormatVersion: stored.formatVersion,
    readerFormatMethod: stored.formatMethod,
    ...(stored.quality
      ? { quality: { verdict: stored.quality.verdict as "full" | "partial", chars: stored.quality.chars, reasons: [] } }
      : {}),
    reused: true
  };
}

async function ingest(url: string, articleId: string, force: boolean, deps: IngestDeps): Promise<IngestResult> {
  const isTextArticle = isSyntheticArticleUrl(url);
  if (!force || isTextArticle) {
    const stored = await deps.loadStored(url).catch(() => undefined);
    // テキスト投入・束の記事は取り直せないので、保存済み本文があれば期間に関係なく使う
    if (isTextArticle) {
      if (stored?.markdown) return fromStored(url, articleId, { ...stored, title: stored.title ?? "テキスト投入" });
      throw new SourceUnavailableError(url, "empty", "本文が取れていません（保存済みの本文がありません）。テキスト投入をやり直してください。");
    }
    if (stored && isReusable(stored, deps.now(), deps.reuseHours)) {
      deps.log(`reuse stored source: ${url} (${stored.markdown.length} chars)`);
      return fromStored(url, articleId, stored);
    }
  }

  // 自分のPCや家庭内ネットワークを指すURLは取りに行かない(全経路共通のチェック)
  try {
    assertPublicHttpUrl(url);
  } catch (error) {
    throw new SourceUnavailableError(
      url,
      "blocked_url",
      `本文が取れていません（${error instanceof Error ? error.message : String(error)}）。`
    );
  }

  let source: SourceContent;
  try {
    source = await deps.fetch(url);
  } catch (error) {
    if (isSourceUnavailableError(error)) {
      await Promise.resolve(deps.saveState(url, { verdict: "failed", chars: 0, message: error.message })).catch(() => {});
    }
    throw error;
  }

  const verdict = source.quality?.verdict === "partial" ? "partial" : "full";
  // 保存は best-effort。保存に失敗しても、取得できた本文での生成は続ける
  await deps.saveSource(url, source).catch((error) => {
    deps.log(`source persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  await Promise.resolve(deps.saveState(url, { verdict, chars: source.quality?.chars ?? source.text.length })).catch(() => {});
  return { ...source, articleId, reused: false };
}

export async function ingestArticle(
  rawUrl: string,
  options: { force?: boolean } = {},
  deps: IngestDeps = defaultDeps()
): Promise<IngestResult> {
  const url = isSyntheticArticleUrl(rawUrl) ? rawUrl.trim() : sanitizeArticleUrl(rawUrl);
  const { articleId } = createArticleIdentity(url);
  const key = `${articleId}:${options.force ? "force" : "normal"}`;
  const running = inFlight.get(key);
  if (running) return running;
  const task = ingest(url, articleId, options.force === true, deps).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

/**
 * 複数URLを記事ごとに取り込み、1つの本文に連結する(従来の複数URLスライド用)。
 * 記事ごとに本文が保存される。1本でも取れなければ全体を止め、どのURLかをメッセージに含める
 * (取れた記事だけで作る部分成功は段階4の束で扱う)。
 */
export async function ingestMultiple(urls: string[], deps?: IngestDeps): Promise<MergedSourceContent> {
  const sources = await Promise.all(
    urls.map(async (url) => {
      try {
        const source = await ingestArticle(url, {}, deps);
        return { url: source.url, title: source.title, body: source.text };
      } catch (error) {
        if (error instanceof SourceUnavailableError) {
          throw new SourceUnavailableError(error.url, error.reason, `${error.message}（対象: ${error.url}）`);
        }
        throw error;
      }
    })
  );
  return mergeSources(sources);
}
