import { extractContent, type ExtractorOptions } from "@local/content-extractor";
import { config } from "../config.js";
import type { SourceContent } from "../types.js";

export type MergedSourceContent = {
  sources: Array<{ url: string; title: string; body: string }>;
  mergedBody: string;
};

const MAX_BODY_LENGTH = 60_000;

/**
 * 抽出オプション(依存注入)。
 * - assetsDir は渡さない → 資産 DL を行わず本文テキストのみ(B のリポジトリにファイルを書かない)。
 * - X 投稿はログイン済みセッション(既定: %USERPROFILE%\.content-extractor\x-session.json)で
 *   本文を Playwright 取得する。セッションファイルが無ければ excerpt フォールバック(従来どおり)。
 */
function buildExtractorOptions(): ExtractorOptions {
  return {
    youtubeApiKey: config.YOUTUBE_API_KEY,
    fetchReferences: false,
    x: {
      sessionStatePath: config.X_SESSION_STATE_PATH,
      headless: config.X_HEADLESS,
      channel: "chrome"
    }
  };
}

/**
 * 単一 URL を共有 content-extractor で取得して SourceContent に変換する。
 */
export async function fetchSourceContent(url: string): Promise<SourceContent> {
  const content = await extractContent({ url }, buildExtractorOptions());

  return {
    url: content.url,
    title: content.title,
    text: content.markdown.slice(0, MAX_BODY_LENGTH),
    author: content.metadata.author,
    publishedAt: content.metadata.publishedAt
  };
}

export async function fetchMultipleSourceContent(urls: string[]): Promise<MergedSourceContent> {
  const sources = await Promise.all(
    urls.map(async (url) => {
      const source = await fetchSourceContent(url);
      return { url: source.url, title: source.title, body: source.text };
    })
  );
  return mergeSources(sources);
}

export async function fetchResearchContent(researchPrompt: string): Promise<MergedSourceContent> {
  if (!config.TAVILY_API_KEY) {
    throw new Error("リサーチモードを使うには TAVILY_API_KEY を設定してください");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: config.TAVILY_API_KEY, query: researchPrompt, max_results: 10 })
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

function mergeSources(sources: Array<{ url: string; title: string; body: string }>): MergedSourceContent {
  return {
    sources,
    mergedBody: sources
      .map((source, index) => `# Source ${index + 1}: ${source.title}\nURL: ${source.url}\n\n${source.body}`)
      .join("\n\n---\n\n")
  };
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
