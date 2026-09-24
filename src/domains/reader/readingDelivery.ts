import { createHash } from "node:crypto";
import {
  InstapaperApiError,
  InstapaperClient,
  type InstapaperBookmark,
  type InstapaperOAuthCredentials
} from "../../integrations/instapaper/instapaperClient.js";
import { renderReadingEdition } from "./readingEdition.js";
import type { ReadingDeliveryStore } from "./localDeliveryStore.js";
import type { ReadingSource } from "./readingSource.js";

// 既存の instapaperDelivery.ts（Reader URL + Firebase 前提）はそのまま残し、
// こちらは出どころを問わない汎用経路として別に持つ。
// sourceUrl があれば従来どおり URL + content 方式、無ければ Private Source 方式で送る。

export type ReadingDeliveryConfig = {
  credentials: Required<InstapaperOAuthCredentials>;
  /** Private Source 方式で Instapaper に表示される送信元名。 */
  privateSourceName?: string;
};

export type ReadingDeliveryResult =
  | { status: "skipped"; mode: DeliveryMode; contentHash: string; bookmarkId?: string }
  | { status: "sent"; mode: DeliveryMode; contentHash: string; bookmarkId: string };

export type DeliveryMode = "url-content" | "private-source";

type BookmarkWriter = {
  addBookmark(input: {
    url?: string;
    title?: string;
    content: string;
    privateSource?: string;
  }): Promise<InstapaperBookmark>;
};

export const DEFAULT_PRIVATE_SOURCE_NAME = "personal-knowledge-vault";

export function resolveDeliveryMode(source: ReadingSource): DeliveryMode {
  return source.sourceUrl ? "url-content" : "private-source";
}

export function renderDeliveryHtml(source: ReadingSource): string {
  return renderReadingEdition({
    title: source.title,
    markdown: source.markdown,
    tldr: source.tldr,
    sourceUrl: source.sourceUrl,
    extractedAt: source.capturedAt,
    // Instapaper は table/tr/td を落とすため、表は箇条書きで送る。
    features: source.richText === false ? undefined : { richText: true, tableLayout: "list" }
  });
}

/**
 * 冪等キーと内容ハッシュで重複送信を防ぐ。
 * Private Source 方式は URL を持たず Instapaper 側で同一判定ができないため、
 * この記録が唯一の重複防止手段になる。
 */
export function computeContentHash(source: ReadingSource): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        // 送る表現が変わったら上げる。2 = 表を箇条書きで送る形式（2026-09-13）
        format: 2,
        key: source.key,
        title: source.title,
        markdown: source.markdown,
        tldr: source.tldr ?? "",
        sourceUrl: source.sourceUrl ?? ""
      }),
      "utf8"
    )
    .digest("hex");
}

export async function deliverReadingSource(
  source: ReadingSource,
  config: ReadingDeliveryConfig,
  store: ReadingDeliveryStore,
  client: BookmarkWriter = new InstapaperClient(config.credentials)
): Promise<ReadingDeliveryResult> {
  const mode = resolveDeliveryMode(source);
  const contentHash = computeContentHash(source);
  const existing = await store.get(source.key);

  if (existing?.status === "completed" && existing.contentHash === contentHash) {
    return { status: "skipped", mode, contentHash, bookmarkId: existing.bookmarkId };
  }

  const content = renderDeliveryHtml(source);
  const title = source.title.trim() || "保存済みメモ";
  await store.put(source.key, { status: "processing", contentHash, target: mode });

  try {
    const bookmark = await client.addBookmark(
      mode === "url-content"
        ? { url: source.sourceUrl, title, content }
        : {
            title,
            content,
            privateSource: config.privateSourceName ?? DEFAULT_PRIVATE_SOURCE_NAME
          }
    );
    const bookmarkId = String(bookmark.bookmark_id);
    await store.put(source.key, { status: "completed", contentHash, bookmarkId, target: mode });
    return { status: "sent", mode, contentHash, bookmarkId };
  } catch (error) {
    await store.put(source.key, {
      status: "failed",
      contentHash,
      target: mode,
      errorCode:
        error instanceof InstapaperApiError
          ? error.apiCode ?? `HTTP_${error.status}`
          : "DELIVERY_FAILED"
    });
    throw error;
  }
}
