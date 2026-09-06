import { createHash } from "node:crypto";
import { createArticleIdentity } from "../../shared/identity.js";
import type { InstapaperDeliveryRecord } from "../../shared/firebaseArticleStore.js";
import {
  InstapaperApiError,
  InstapaperClient,
  type InstapaperBookmark,
  type InstapaperOAuthCredentials
} from "../../integrations/instapaper/instapaperClient.js";
import { renderReadingEdition } from "./readingEdition.js";

export type InstapaperDeliveryInput = {
  articleUrl: string;
  title: string;
  markdown: string;
  tldr?: string;
  extractedAt?: string;
};

export type InstapaperDeliveryConfig = {
  readerBaseUrl: string;
  credentials: Required<InstapaperOAuthCredentials>;
};

export type InstapaperDeliveryStore = {
  get(articleUrl: string): Promise<InstapaperDeliveryRecord | undefined>;
  put(
    articleUrl: string,
    record: Omit<InstapaperDeliveryRecord, "updatedAt">
  ): Promise<void>;
};

type InstapaperBookmarkWriter = {
  addBookmark(input: {
    url: string;
    title: string;
    content: string;
  }): Promise<InstapaperBookmark>;
};

export type InstapaperDeliveryResult =
  | { status: "skipped"; readerUrl: string; contentHash: string; bookmarkId?: string }
  | { status: "sent"; readerUrl: string; contentHash: string; bookmarkId: string };

export async function deliverReadingEditionToInstapaper(
  input: InstapaperDeliveryInput,
  config: InstapaperDeliveryConfig,
  store: InstapaperDeliveryStore,
  client: InstapaperBookmarkWriter = new InstapaperClient(config.credentials)
): Promise<InstapaperDeliveryResult> {
  const readerUrl = buildReaderUrl(config.readerBaseUrl, input.articleUrl);
  const content = renderReadingEdition({
    title: input.title,
    markdown: input.markdown,
    tldr: input.tldr,
    sourceUrl: input.articleUrl,
    extractedAt: input.extractedAt
  });
  // 保存日時だけが変わった再実行は同一内容として扱う。本文・要約・タイトル・リンクの
  // いずれかが変わった時だけInstapaperを更新する。
  const contentHash = createHash("sha256")
    .update(JSON.stringify({
      format: 1,
      readerUrl,
      articleUrl: input.articleUrl,
      title: input.title,
      markdown: input.markdown,
      tldr: input.tldr ?? ""
    }), "utf8")
    .digest("hex");
  const existing = await store.get(input.articleUrl);

  if (
    existing?.status === "completed" &&
    existing.contentHash === contentHash &&
    existing.readerUrl === readerUrl
  ) {
    return {
      status: "skipped",
      readerUrl,
      contentHash,
      bookmarkId: existing.bookmarkId
    };
  }

  await store.put(input.articleUrl, {
    status: "processing",
    contentHash,
    readerUrl
  });

  try {
    const bookmark = await client.addBookmark({
      url: readerUrl,
      title: input.title.trim() || "保存済み記事",
      content
    });
    const bookmarkId = String(bookmark.bookmark_id);
    await store.put(input.articleUrl, {
      status: "completed",
      contentHash,
      readerUrl,
      bookmarkId
    });
    return { status: "sent", readerUrl, contentHash, bookmarkId };
  } catch (error) {
    await store.put(input.articleUrl, {
      status: "failed",
      contentHash,
      readerUrl,
      errorCode: error instanceof InstapaperApiError ? error.apiCode ?? `HTTP_${error.status}` : "DELIVERY_FAILED"
    });
    throw error;
  }
}

export function buildReaderUrl(readerBaseUrl: string, articleUrl: string): string {
  const readerUrl = new URL(readerBaseUrl);
  readerUrl.hash = "";
  readerUrl.searchParams.set("reader", createArticleIdentity(articleUrl).articleId);
  return readerUrl.toString();
}
