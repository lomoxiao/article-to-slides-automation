export type SlideArgs =
  | {
      ok: true;
      urls: string[];
      researchPrompt: undefined;
      audience?: string;
      focus?: string;
      pages?: number;
    }
  | {
      ok: true;
      urls: undefined;
      researchPrompt: string;
      audience?: string;
      focus?: string;
      pages?: number;
    }
  | { ok: false; errorMessage: string };

// /slides --url https://a.com
// -> { ok: true, urls: ["https://a.com"] }
//
// /slides --url https://a.com,https://b.com,https://c.com --pages 10
// -> { ok: true, urls: ["https://a.com","https://b.com","https://c.com"], pages: 10 }
//
// /slides --url https://a.com, https://b.com --pages 10
// -> { ok: true, urls: ["https://a.com","https://b.com"], pages: 10 }
//
// /slides --url https://a.com,https://b.com,https://c.com,https://d.com
// -> { ok: false, errorMessage: "URL は最大3件まで指定できます" }
//
// /slides --research "AI最新動向" --focus "日本企業への影響" --pages 8
// -> { ok: true, researchPrompt: "AI最新動向", focus: "日本企業への影響", pages: 8 }
//
// /slides --url https://a.com --research "something"
// -> { ok: false, errorMessage: "--url と --research は同時に指定できません" }
//
// /slides https://example.com  (後方互換)
// -> { ok: true, urls: ["https://example.com"] }

type ParsedOptions = {
  url?: string;
  research?: string;
  audience?: string;
  focus?: string;
  pages?: string;
  hasFlag: boolean;
};

type TokenizeResult =
  | { ok: true; tokens: string[] }
  | { ok: false; errorMessage: string };

const urlPattern = /https?:\/\/[^\s<>()]+/i;
const supportedFlags = new Set(["--url", "--research", "--audience", "--focus", "--pages"]);

export function parseSlideArgs(text: string): SlideArgs {
  const tokenizeResult = tokenizeArgs(text);
  if (!tokenizeResult.ok) {
    return tokenizeResult;
  }

  const tokens = tokenizeResult.tokens;
  const options: ParsedOptions = { hasFlag: tokens.some((token) => token.startsWith("--")) };
  const unconsumed: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "/slides" || token === "[slide-generate]") {
      continue;
    }

    if (!token.startsWith("--")) {
      unconsumed.push(token);
      continue;
    }

    if (!supportedFlags.has(token)) {
      return { ok: false, errorMessage: `未対応の引数です: ${token}` };
    }

    const { value, nextIndex } = readFlagValue(tokens, index);
    if (!value) {
      return { ok: false, errorMessage: `${token} の値を指定してください` };
    }

    switch (token) {
      case "--url":
        options.url = value.replace(/\s*,\s*/g, ",").trim();
        break;
      case "--research":
        options.research = sanitizeTextValue(value);
        break;
      case "--audience":
        options.audience = sanitizeTextValue(value);
        break;
      case "--focus":
        options.focus = sanitizeTextValue(value);
        break;
      case "--pages":
        options.pages = value.trim();
        break;
    }

    index = nextIndex;
  }

  if (options.hasFlag && unconsumed.length > 0) {
    return {
      ok: false,
      errorMessage: `解釈できない引数があります: ${unconsumed.join(" ")}`
    };
  }

  if (options.url && options.research) {
    return { ok: false, errorMessage: "--url と --research は同時に指定できません" };
  }

  const pagesResult = parsePages(options.pages);
  if (!pagesResult.ok) {
    return pagesResult;
  }

  if (options.url) {
    const urls = options.url
      .split(",")
      .map((url) => normalizeUrl(url))
      .filter(Boolean);

    if (urls.length > 3) {
      return { ok: false, errorMessage: "URL は最大3件まで指定できます" };
    }

    if (urls.length === 0 || urls.some((url) => !/^https?:\/\//i.test(url))) {
      return { ok: false, errorMessage: "--url には http(s) の URL を指定してください" };
    }

    return {
      ok: true,
      urls,
      researchPrompt: undefined,
      audience: options.audience,
      focus: options.focus,
      pages: pagesResult.pages
    };
  }

  if (options.research) {
    return {
      ok: true,
      urls: undefined,
      researchPrompt: options.research,
      audience: options.audience,
      focus: options.focus,
      pages: pagesResult.pages
    };
  }

  if (!options.hasFlag) {
    const url = normalizeUrl(text.match(urlPattern)?.[0] ?? "");
    if (url) {
      return {
        ok: true,
        urls: [url],
        researchPrompt: undefined,
        pages: pagesResult.pages
      };
    }
  }

  return {
    ok: false,
    errorMessage: "`--url` または `--research` を指定してください"
  };
}

function readFlagValue(tokens: string[], flagIndex: number): { value: string; nextIndex: number } {
  const values: string[] = [];
  let index = flagIndex + 1;

  while (index < tokens.length && !tokens[index].startsWith("--")) {
    values.push(tokens[index]);
    index += 1;
  }

  return {
    value: values.join(" ").trim(),
    nextIndex: index - 1
  };
}

function parsePages(value: string | undefined): { ok: true; pages?: number } | { ok: false; errorMessage: string } {
  if (value === undefined) {
    return { ok: true };
  }

  if (!/^\d+$/.test(value)) {
    return { ok: false, errorMessage: "--pages には整数を指定してください" };
  }

  return { ok: true, pages: Number(value) };
}

function tokenizeArgs(text: string): TokenizeResult {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let escaping = false;

  for (const char of text.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && inQuote) {
      escaping = true;
      continue;
    }

    if (char === "\"") {
      inQuote = !inQuote;
      continue;
    }

    if (/\s/u.test(char) && !inQuote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (inQuote) {
    return { ok: false, errorMessage: "ダブルクォートが閉じられていません" };
  }

  if (current) {
    tokens.push(current);
  }

  return { ok: true, tokens };
}

function normalizeUrl(value: string): string {
  const slackLink = value.trim().match(/^<((?:https?:\/\/)[^>|]+)(?:\|[^>]*)?>$/);
  const url = slackLink?.[1] ?? value.trim();
  return url.replace(/[.,;:!?)}\]>]+$/u, "");
}

function sanitizeTextValue(value: string): string {
  return value
    .replace(/<https?:\/\/[^>|]+\|([^>]*)>/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
