import { config } from "../config.js";
import type { SourceContent } from "../types.js";

export type MergedSourceContent = {
  sources: Array<{ url: string; title: string; body: string }>;
  mergedBody: string;
};

export async function fetchSourceContent(url: string): Promise<SourceContent> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "article-to-slides-automation/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const title = extractTitle(html) ?? url;
  const text = stripHtml(html).slice(0, 60_000);

  return {
    url,
    title,
    text
  };
}

export async function fetchMultipleSourceContent(urls: string[]): Promise<MergedSourceContent> {
  const sources = await Promise.all(
    urls.map(async (url) => {
      const source = await fetchSourceContent(url);
      return {
        url: source.url,
        title: source.title,
        body: source.text
      };
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
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      api_key: config.TAVILY_API_KEY,
      query: researchPrompt,
      max_results: 10
    })
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
  results?: Array<{
    url: string;
    title?: string;
    content?: string;
    snippet?: string;
  }>;
};

function dedupeTavilyResults(results: NonNullable<TavilySearchResponse["results"]>) {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (!result.url || seen.has(result.url)) {
      return false;
    }

    seen.add(result.url);
    return true;
  });
}

function extractTitle(html: string): string | undefined {
  return html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
