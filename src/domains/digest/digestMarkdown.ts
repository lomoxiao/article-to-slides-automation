import type { DigestInput } from "./digestInput.js";

/** 例: 2026-11-15 → "今日のまとめ 11/15" */
export function buildDigestTitle(date: string): string {
  const [, month, day] = date.split("-");
  return `今日のまとめ ${Number(month)}/${Number(day)}`;
}

/** 見出し記号や改行で Markdown の構造を壊さないよう、1行のテキストに整える。 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim();
}

/**
 * まとめの本文を AI を使わずに組み立てる。
 * Viewer の Reader が扱える範囲(見出し・段落)だけを使う。Reader はリンク記法を表示しないため、
 * 出典は「出典: 媒体名 URL」の素の形で書く。
 */
export function buildDigestMarkdown(input: DigestInput): string {
  const blocks: string[] = [];
  for (const chapter of input.chapters) {
    blocks.push(`## ${oneLine(chapter.title)}`);
    for (const article of chapter.articles) {
      blocks.push(`### ${oneLine(article.title)}`);
      blocks.push(oneLine(article.summary));
      blocks.push(`出典: ${[oneLine(article.source), article.url].filter(Boolean).join(" ")}`);
    }
  }
  return blocks.join("\n\n");
}
