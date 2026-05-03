import type { SourceContent } from "../types.js";

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

