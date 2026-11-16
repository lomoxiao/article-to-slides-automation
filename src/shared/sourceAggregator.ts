import {
  extractContent,
  type ExtractedContent,
  type ExtractionQuality,
  type ExtractorOptions
} from "@local/content-extractor";
import { config } from "../config.js";
import type { SourceContent } from "../types/content.js";
import { sanitizeArticleUrl } from "../utils/url.js";
import { SourceUnavailableError, describeSourceFailure } from "./sourceErrors.js";
import { loadPaginationDomainRules, recordPaginationSuccess } from "./paginationDomainStore.js";

export type MergedSourceContent = {
  sources: Array<{ url: string; title: string; body: string }>;
  mergedBody: string;
  /** 単一URL取得時の品質判定(複数URL・テキスト投入・リサーチでは付かない)。 */
  quality?: SourceContent["quality"];
  readerFormatVersion?: number;
  readerFormatMethod?: string;
};

const MAX_BODY_LENGTH = 60_000;

/**
 * 抽出オプション(依存注入)。
 * - assetsDir は渡さない → 資産 DL を行わず本文テキストのみ(B のリポジトリにファイルを書かない)。
 * - X 投稿はログイン済みセッション(既定: %USERPROFILE%\.content-extractor\x-session.json)で
 *   本文を Playwright 取得する。セッションファイルが無ければ excerpt フォールバック(従来どおり)。
 */
export function buildExtractorOptions(): ExtractorOptions {
  return {
    youtubeApiKey: config.web.youtubeApiKey,
    fetchReferences: false,
    http: {
      userAgent: config.web.httpUserAgent,
      timeoutMs: config.web.httpTimeoutMs
    },
    x: {
      sessionStatePath: config.web.xSessionStatePath,
      headless: config.web.xHeadless,
      channel: "chrome"
    },
    // web記事の複数ページ巡回。ドメイン別の成功パターンを学習ストアから読み、
    // 成功時に move-to-front で保存する。60kトランケートは連結後の本文に適用される。
    pagination: {
      domainRules: loadPaginationDomainRules(),
      onPatternSuccess: recordPaginationSuccess
    },
    // ログイン必須サイトのセッション取得。セッションは npm run session:capture -- <domain> で保存。
    playwrightSessions: {
      dir: config.web.sessionsDir,
      loginRequiredDomains: config.web.loginRequiredDomains.split(",")
        .map((domain) => domain.trim())
        .filter(Boolean),
      headless: config.web.xHeadless,
      channel: "chrome"
    }
  };
}

/** fetchSourceDebug.ts 用: 進捗ログ付きの抽出オプション。 */
export function buildDebugExtractorOptions(): ExtractorOptions {
  return {
    ...buildExtractorOptions(),
    logger: {
      info: (message) => console.log(`[extract] ${message}`),
      warn: (message) => console.warn(`[extract] ${message}`),
      error: (message) => console.error(`[extract] ${message}`)
    }
  };
}

type ExtractFn = (url: string) => Promise<ExtractedContent>;

function readQuality(content: ExtractedContent): ExtractionQuality | undefined {
  const quality = content.metadata.quality;
  if (!quality || typeof quality !== "object") return undefined;
  const { verdict, chars, reasons } = quality as Partial<ExtractionQuality>;
  if (verdict !== "full" && verdict !== "partial" && verdict !== "failed") return undefined;
  return { verdict, chars: typeof chars === "number" ? chars : 0, reasons: Array.isArray(reasons) ? reasons : [] };
}

/**
 * 単一 URL を共有 content-extractor で取得して SourceContent に変換する。
 *
 * 取り込みの関門: 取得エラー(403・タイムアウト等)と、品質判定が failed の本文は
 * SourceUnavailableError として投げ、空の本文から成果物が作られないようにする。
 * partial(一部のみの疑い)は quality を付けて返し、生成は続ける。
 */
export async function fetchSourceContent(
  rawUrl: string,
  extract: ExtractFn = (url) => extractContent({ url }, buildExtractorOptions())
): Promise<SourceContent> {
  const url = sanitizeArticleUrl(rawUrl);

  let content: ExtractedContent;
  try {
    content = await extract(url);
  } catch (error) {
    if (error instanceof Error && error.name === "ExtractionFailedError") {
      const { code, status } = error as Error & { code?: string; status?: number };
      const reason = code ?? "other";
      throw new SourceUnavailableError(url, reason, describeSourceFailure(reason, { status }));
    }
    throw error; // SessionExpiredError などは従来どおり呼び出し側で扱う
  }

  const quality = readQuality(content);
  if (quality?.verdict === "failed") {
    const reason = quality.reasons[0] ?? "too_short";
    throw new SourceUnavailableError(url, reason, describeSourceFailure(reason, { chars: quality.chars }));
  }

  const readerFormatVersion =
    typeof content.metadata.readerFormatVersion === "number"
      ? content.metadata.readerFormatVersion
      : undefined;
  const readerFormatMethod =
    typeof content.metadata.readerFormatMethod === "string"
      ? content.metadata.readerFormatMethod
      : undefined;

  return {
    url: content.url,
    title: content.title,
    text: truncateMarkdown(content.markdown, MAX_BODY_LENGTH),
    author: content.metadata.author,
    publishedAt: content.metadata.publishedAt,
    readerFormatVersion,
    readerFormatMethod,
    ...(quality ? { quality } : {})
  };
}

export async function fetchResearchContent(researchPrompt: string): Promise<MergedSourceContent> {
  if (!config.web.tavilyApiKey) {
    throw new Error("リサーチモードを使うには TAVILY_API_KEY を設定してください");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: config.web.tavilyApiKey, query: researchPrompt, max_results: 10 })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status} ${response.statusText}\n${text}`);
  }

  const result = JSON.parse(text) as TavilySearchResponse;
  const searchResults = dedupeTavilyResults(result.results ?? []).slice(0, 10);

  if (searchResults.length === 0) {
    throw new Error("Tavily search returned no results");
  }

  const sources = await Promise.all(
    searchResults.map(async (searchResult) => {
      try {
        const source = await fetchSourceContent(searchResult.url);
        return {
          url: source.url,
          title: source.title || searchResult.title || source.url,
          body: source.text
        };
      } catch {
        return {
          url: searchResult.url,
          title: searchResult.title || searchResult.url,
          body: searchResult.content || searchResult.snippet || ""
        };
      }
    })
  );

  return mergeSources(sources.filter((source) => source.body.trim().length > 0));
}

export function mergeSources(sources: Array<{ url: string; title: string; body: string }>): MergedSourceContent {
  return {
    sources,
    mergedBody: sources
      .map((source, index) => `# Source ${index + 1}: ${source.title}\nURL: ${source.url}\n\n${source.body}`)
      .join("\n\n---\n\n"),
    readerFormatVersion: 2,
    readerFormatMethod: "multi_source"
  };
}

export function truncateMarkdown(markdown: string, maxLength: number): string {
  if (markdown.length <= maxLength) return markdown;
  const notice = "\n\n[本文は文字数上限のため省略されました]";
  const limit = Math.max(0, maxLength - notice.length);
  const blockBoundary = markdown.lastIndexOf("\n\n", limit);
  const lineBoundary = markdown.lastIndexOf("\n", limit);
  const cutoff =
    blockBoundary >= Math.floor(limit * 0.75)
      ? blockBoundary
      : lineBoundary >= Math.floor(limit * 0.75)
        ? lineBoundary
        : limit;
  return markdown.slice(0, cutoff).trimEnd() + notice;
}

type TavilySearchResponse = {
  results?: Array<{ url: string; title?: string; content?: string; snippet?: string }>;
};

function dedupeTavilyResults(results: NonNullable<TavilySearchResponse["results"]>) {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}
