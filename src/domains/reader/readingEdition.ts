export type ReadingEditionInput = {
  title: string;
  markdown: string;
  tldr?: string;
  sourceUrl?: string;
  extractedAt?: string;
};

export function renderReadingEdition(input: ReadingEditionInput): string {
  const title = input.title.trim() || "保存済み記事";
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const tldrItems = parseTldr(input.tldr);
  const body = renderMarkdownBlocks(input.markdown);
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
  </style>
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

function renderMarkdownBlocks(markdown: string): string {
  const output: string[] = [];
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | undefined;
  let listItems: string[] = [];
  let codeLines: string[] | undefined;
  let quoteLines: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(escapeHtml).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType || !listItems.length) return;
    output.push(`<${listType}>${listItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${listType}>`);
    listType = undefined;
    listItems = [];
  };
  const flushQuote = () => {
    if (!quoteLines.length) return;
    output.push(
      "<blockquote><p>" +
        quoteLines.map(escapeHtml).join("<br>") +
        "</p></blockquote>"
    );
    quoteLines = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
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
      output.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
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
