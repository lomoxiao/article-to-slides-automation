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

  const contentType = response.headers.get("content-type") ?? "";
  const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
  const charset = charsetMatch?.[1]?.toLowerCase().replace("shift_jis", "shift-jis") ?? "utf-8";
  const buffer = await response.arrayBuffer();
  const html = new TextDecoder(charset).decode(buffer);
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
  const cleanedHtml = removeNonContentBlocks(html);
  const contentHtml = extractPrimaryContentHtml(cleanedHtml);

  return decodeHtmlEntities(contentHtml
    .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function removeNonContentBlocks(html: string): string {
  return html.replace(
    /<(script|style|nav|header|footer|aside|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " "
  );
}

function extractPrimaryContentHtml(html: string): string {
  return extractFirstTagContent(html, "article")
    ?? extractFirstTagContent(html, "main")
    ?? extractFirstSemanticContainerContent(html)
    ?? html;
}

function extractFirstTagContent(html: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  return html.match(pattern)?.[1];
}

function extractFirstSemanticContainerContent(html: string): string | undefined {
  const semanticContainerPattern = /<(div|section)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;

  while ((match = semanticContainerPattern.exec(html)) !== null) {
    if (attributesContainContentHint(match[2] ?? "")) {
      return match[3];
    }
  }

  return undefined;
}

function attributesContainContentHint(attributes: string): boolean {
  const attributePattern = /\b(id|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(attributes)) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (/(content|article|post|entry|body)/i.test(value)) {
      return true;
    }
  }

  return false;
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value: string) => {
    const lowerValue = value.toLowerCase();

    if (lowerValue.startsWith("#x")) {
      return decodeCodePoint(Number.parseInt(lowerValue.slice(2), 16), entity);
    }

    if (lowerValue.startsWith("#")) {
      return decodeCodePoint(Number.parseInt(lowerValue.slice(1), 10), entity);
    }

    switch (lowerValue) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return "\"";
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default:
        return entity;
    }
  });
}

function decodeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}
