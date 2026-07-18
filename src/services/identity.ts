import { createHash } from "node:crypto";

export type ArticleIdentity = {
  articleId: string;
  canonicalUrl: string;
  sourceKind: "web" | "youtube" | "text";
};

// URLを持たないテキスト投入記事の合成canonical。articleIdと同値を埋め込むことで
// URLキー前提の既存パイプライン(jobStore/artifact書き込み/診断)をそのまま流用する。
const TEXT_CANONICAL_PATTERN = /^text:(txt_[0-9a-f]{12})$/;

const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "gbraid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "wbraid"
]);

export function createArticleIdentity(rawUrl: string): ArticleIdentity {
  const textMatch = rawUrl.trim().match(TEXT_CANONICAL_PATTERN);
  if (textMatch) {
    return {
      articleId: textMatch[1],
      canonicalUrl: rawUrl.trim(),
      sourceKind: "text"
    };
  }

  const youtubeVideoId = extractYouTubeVideoId(rawUrl);
  if (youtubeVideoId) {
    const canonicalUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
    return {
      articleId: `yt_${shortHash(youtubeVideoId)}`,
      canonicalUrl,
      sourceKind: "youtube"
    };
  }

  const canonicalUrl = normalizeWebUrl(rawUrl);
  return {
    articleId: `url_${shortHash(canonicalUrl)}`,
    canonicalUrl,
    sourceKind: "web"
  };
}

export function createTextArticleIdentity(text: string): ArticleIdentity {
  // 同一本文の再投稿を同じ記事ノードへ収束させるため、改行差異だけは吸収する
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const canonicalUrl = `text:txt_${shortHash(normalized)}`;
  return createArticleIdentity(canonicalUrl);
}

export function normalizeSlidesUrl(url: string, presentationId?: string | null): string {
  const id = presentationId || extractPresentationId(url);
  return id ? `https://docs.google.com/presentation/d/${encodeURIComponent(id)}/edit` : url;
}

export function normalizeWebUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.searchParams.forEach((_, key) => {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    });
    parsed.searchParams.sort();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function extractYouTubeVideoId(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0];
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (parsed.pathname === "/watch") {
        return parsed.searchParams.get("v") ?? undefined;
      }
      const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/]+)/);
      if (shortsMatch) {
        return shortsMatch[1];
      }
      const embedMatch = parsed.pathname.match(/^\/embed\/([^/]+)/);
      if (embedMatch) {
        return embedMatch[1];
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function extractPresentationId(url: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    const pathMatch = parsed.pathname.match(/\/presentation\/d\/([^/]+)/);
    return pathMatch?.[1] || parsed.searchParams.get("id") || undefined;
  } catch {
    const pathMatch = url.match(/\/presentation\/d\/([^/]+)/);
    const openMatch = url.match(/[?&]id=([^&]+)/);
    return pathMatch?.[1] || openMatch?.[1];
  }
}

export function getUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
