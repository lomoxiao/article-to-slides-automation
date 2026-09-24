// Instapaper へ送る「読み物」の共通表現。
// 入力の出どころ（Vault の成果物・任意の Markdown ファイル・標準入力・将来の会話ログ）に
// 依存しない形にしておき、送信側はこの型だけを見る。

export type ReadingSourceOrigin = "vault-artifact" | "markdown-file" | "stdin" | "inline";

export type ReadingSource = {
  /** 冪等キー。同じキーで内容が同じなら再送しない。 */
  key: string;
  title: string;
  markdown: string;
  tldr?: string;
  /** あれば URL + content 方式、無ければ Private Source 方式で送る。 */
  sourceUrl?: string;
  capturedAt?: string;
  origin: ReadingSourceOrigin;
  /** 表やインライン記法を解釈するか。既定は有効（Markdown 入力を前提とするため）。 */
  richText?: boolean;
};

export type ParsedMarkdownDocument = {
  frontmatter: Record<string, string>;
  title?: string;
  body: string;
};

/**
 * YAML frontmatter を切り離し、最初の H1 をタイトルとして取り出す。
 * frontmatter は「キー: 値」の浅い形だけを読む（Vault の成果物がこの形のため）。
 */
export function parseMarkdownDocument(markdown: string): ParsedMarkdownDocument {
  const normalized = markdown.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const frontmatter: Record<string, string> = {};
  let body = normalized;

  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match) {
    for (const line of match[1].split("\n")) {
      const entry = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (!entry) continue;
      frontmatter[entry[1]] = entry[2].trim().replace(/^["'](.*)["']$/, "$1");
    }
    body = normalized.slice(match[0].length);
  }

  let title: string | undefined;
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) {
    title = heading[1].trim();
    // 見出しを本文から外し、タイトルの二重表示を避ける。
    body = body.replace(heading[0], "").replace(/^\n+/, "");
  }

  return { frontmatter, title, body };
}

/**
 * Obsidian の [[wikilink]] を、電子書籍リーダーで意味の通る表記へ置き換える。
 * リンク先へは飛べないため、出典が読み取れる最小限の文字列だけを残す。
 */
export function flattenWikiLinks(markdown: string): string {
  return markdown.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => {
    const label = (alias ?? target).trim();
    const leaf = label.split("/").filter(Boolean).pop() ?? label;
    return `（出典: ${leaf}）`;
  });
}

/** Markdown 本文を読み物として整える共通処理。 */
export function normalizeReadingMarkdown(markdown: string): string {
  return flattenWikiLinks(markdown).replace(/\n{3,}/g, "\n\n").trim();
}
