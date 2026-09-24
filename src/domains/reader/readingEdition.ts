export type ReadingEditionInput = {
  title: string;
  markdown: string;
  tldr?: string;
  sourceUrl?: string;
  extractedAt?: string;
  /**
   * 既定では無効。Vault の成果物のように Markdown の表現力を活かしたい入力でのみ
   * 明示的に有効化する。既存の Web 記事経路は features を渡さないため、
   * 出力は従来と 1 バイトも変わらない。
   */
  features?: ReadingEditionFeatures;
};

export type ReadingEditionFeatures = {
  /** 表組みと、太字・コード・リンクのインライン記法を解釈する。 */
  richText?: boolean;
  /**
   * 表の描画形式。既定は "table"。
   * Instapaper のパーサは table/tbody/tr/td を除去し thead/th だけ残すため、
   * Instapaper 経由で読む場合は "list"（行ごとの入れ子の箇条書き）を使う。
   */
  tableLayout?: "table" | "list";
};

export function renderReadingEdition(input: ReadingEditionInput): string {
  const title = input.title.trim() || "保存済み記事";
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const tldrItems = parseTldr(input.tldr);
  const body = renderMarkdownBlocks(input.markdown, input.features ?? {});
  const meta = input.extractedAt
    ? `<p class="reader-meta"><span>保存日時</span> ${escapeHtml(input.extractedAt)}</p>`
    : "";
  const tldr = tldrItems.length
    ? `<section class="reader-summary" aria-labelledby="reader-summary-title">
      <h2 id="reader-summary-title">3行要約</h2>
      <ul>${tldrItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>`
    : "";
  const source = sourceUrl
    ? `<footer class="reader-source"><a href="${escapeHtml(sourceUrl)}">元記事を開く</a></footer>`
    : "";
  // 表組みを使うときだけスタイルを足す。features を渡さない既存の呼び出しでは
  // 空文字になるため、出力は従来と完全に一致する。
  const richTextStyle = input.features?.richText
    ? `
  <style>
    .reader-table { margin: 0 0 1.4rem; }
    .reader-table table { width: 100%; border-collapse: collapse; font-size: .82em; line-height: 1.55; }
    .reader-table th, .reader-table td { padding: .35em .5em; border: 1px solid #b8b4aa; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    .reader-table th { font-weight: 700; }
    .reader-table-list { padding-left: 1.2em; }
    .reader-table-list > li { margin: 0 0 .8em; }
    .reader-table-list ul { padding-left: 1.2em; margin: .2em 0 0; }
    .reader-table-list ul li { margin: 0; }
    @media (prefers-color-scheme: dark) {
      .reader-table th, .reader-table td { border-color: #55534e; }
    }
  </style>`
    : "";

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Georgia, "Yu Mincho", "Hiragino Mincho ProN", serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f7f5ef; color: #1d1d1b; font-size: 19px; line-height: 1.85; }
    article { width: min(100%, 42rem); margin: 0 auto; padding: 1.4rem 1.15rem 4rem; overflow-wrap: anywhere; }
    header { margin-bottom: 2rem; border-bottom: 1px solid #b8b4aa; }
    h1 { margin: 0 0 .75rem; font-size: 1.7rem; line-height: 1.35; }
    h2 { margin: 2rem 0 .8rem; font-size: 1.3rem; line-height: 1.45; }
    h3, h4 { margin: 1.7rem 0 .7rem; font-size: 1.12rem; line-height: 1.5; }
    p { margin: 0 0 1.25rem; }
    ul, ol { margin: 0 0 1.4rem; padding-left: 1.4rem; }
    li { margin: 0 0 .6rem; }
    blockquote { margin: 1.3rem 0; padding-left: 1rem; border-left: .2rem solid #8c887e; color: #4c4a45; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font: .84em/1.65 ui-monospace, monospace; }
    a { color: inherit; text-decoration-thickness: .08em; text-underline-offset: .15em; }
    .reader-meta { margin: 0 0 1rem; color: #68655e; font: .78rem/1.5 system-ui, sans-serif; }
    .reader-meta span { font-weight: 700; }
    .reader-summary { margin: 0 0 2rem; padding: .1rem 1rem .15rem; border: 1px solid #aaa69c; }
    .reader-summary h2 { margin-top: .8rem; }
    .reader-source { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #b8b4aa; font-family: system-ui, sans-serif; }
    @media (prefers-color-scheme: dark) {
      body { background: #111; color: #e8e6df; }
      header, .reader-source { border-color: #55534e; }
      blockquote, .reader-meta { color: #bbb7ad; }
      .reader-summary { border-color: #66635b; }
    }
  </style>${richTextStyle}
</head>
<body>
<article data-reader-format="2">
  <header><h1>${escapeHtml(title)}</h1>${meta}</header>
  ${tldr}
  <main>${body || "<p>本文がありません。</p>"}</main>
  ${source}
</article>
</body>
</html>`;
}

function parseTldr(tldr: string | undefined): string[] {
  if (!tldr) return [];
  return tldr
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter(Boolean)
    .slice(0, 3);
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function renderMarkdownBlocks(markdown: string, features: ReadingEditionFeatures): string {
  const rich = features.richText === true;
  const tableLayout = features.tableLayout ?? "table";
  const inline = (value: string): string => (rich ? renderInline(value) : escapeHtml(value));
  const output: string[] = [];
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | undefined;
  let listItems: string[] = [];
  let codeLines: string[] | undefined;
  let quoteLines: string[] = [];
  let tableLines: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType || !listItems.length) return;
    output.push(`<${listType}>${listItems.map((item) => `<li>${inline(item)}</li>`).join("")}</${listType}>`);
    listType = undefined;
    listItems = [];
  };
  const flushQuote = () => {
    if (!quoteLines.length) return;
    output.push(
      "<blockquote><p>" +
        quoteLines.map(inline).join("<br>") +
        "</p></blockquote>"
    );
    quoteLines = [];
  };
  const flushTable = () => {
    if (!tableLines.length) return;
    const rendered = renderTable(tableLines, inline, tableLayout);
    // 表として解釈できなかった行は、従来どおり段落として残す。
    output.push(rendered ?? `<p>${tableLines.map(inline).join("<br>")}</p>`);
    tableLines = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  };

  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (codeLines) {
      if (/^```/.test(line)) {
        output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = undefined;
      } else {
        codeLines.push(rawLine);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushAll();
      codeLines = [];
      continue;
    }
    if (!line) {
      flushAll();
      continue;
    }
    if (rich && /^\|.*\|$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      tableLines.push(line);
      continue;
    }
    flushTable();
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1]);
      continue;
    }
    flushQuote();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 1, 4);
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^([-*_])(?:\s*\1){2,}$/.test(line)) {
      flushAll();
      output.push("<hr>");
      continue;
    }
    const unordered = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered ?? ordered)?.[1] ?? "");
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (codeLines) output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  flushAll();
  return output.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * GFM 風の表を <table> へ変換する。ヘッダ行と区切り行（|---|---|）が揃っている場合だけ
 * 表として扱い、それ以外は null を返して呼び出し側の段落フォールバックに委ねる。
 */
function renderTable(
  lines: string[],
  inline: (value: string) => string,
  layout: "table" | "list"
): string | undefined {
  if (lines.length < 2) return undefined;
  const cells = (line: string): string[] =>
    line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const header = cells(lines[0]);
  const divider = cells(lines[1]);
  if (!header.length || divider.length !== header.length) return undefined;
  if (!divider.every((cell) => /^:?-{1,}:?$/.test(cell))) return undefined;

  if (layout === "list") {
    const rows = lines.slice(2).map((line) => {
      const row = cells(line);
      return Array.from({ length: header.length }, (_, index) => row[index] ?? "");
    });
    return renderTableAsList(header, rows, inline);
  }

  const align = divider.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return undefined;
  });
  const cellAttribute = (index: number): string =>
    align[index] ? ` style="text-align:${align[index]}"` : "";

  const head = `<thead><tr>${header
    .map((cell, index) => `<th${cellAttribute(index)}>${inline(cell)}</th>`)
    .join("")}</tr></thead>`;
  const bodyRows = lines.slice(2).map((line) => {
    const row = cells(line);
    const normalized = Array.from({ length: header.length }, (_, index) => row[index] ?? "");
    return `<tr>${normalized
      .map((cell, index) => `<td${cellAttribute(index)}>${inline(cell)}</td>`)
      .join("")}</tr>`;
  });
  const body = bodyRows.length ? `<tbody>${bodyRows.join("")}</tbody>` : "";
  return `<div class="reader-table"><table>${head}${body}</table></div>`;
}

/**
 * 表を行ごとの入れ子の箇条書きにする。先頭列を行の見出しにし、残りの列は
 * 「列名: 値」の子項目にする。先頭列が "#" の連番なら 2 列目と合わせて
 * 「1. 見出し」の形にする。空のセルは省く。
 */
function renderTableAsList(
  header: string[],
  rows: string[][],
  inline: (value: string) => string
): string {
  const numbered = header[0] === "#" && header.length >= 2;
  const detailStart = numbered ? 2 : 1;
  const items = rows.map((row) => {
    const label = numbered ? [row[0], row[1]].filter(Boolean).join(". ") : row[0];
    const details = header
      .slice(detailStart)
      .map((name, offset) => ({ name, value: row[detailStart + offset] }))
      .filter(({ value }) => value)
      .map(({ name, value }) => `<li>${inline(name)}: ${inline(value)}</li>`);
    const nested = details.length ? `<ul>${details.join("")}</ul>` : "";
    return `<li><strong>${inline(label)}</strong>${nested}</li>`;
  });
  return `<ul class="reader-table-list">${items.join("")}</ul>`;
}

/**
 * 先にエスケープしてからインライン記法を適用する。エスケープ後の文字列を対象にするため、
 * 入力に含まれる生の HTML がタグとして復活することはない。
 */
function renderInline(value: string): string {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, href: string) => {
    const url = normalizeHttpUrl(unescapeHtml(href));
    return url ? `<a href="${escapeHtml(url)}">${text}</a>` : match;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, (_match, text: string) => `<strong>${text}</strong>`);
  return html;
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
