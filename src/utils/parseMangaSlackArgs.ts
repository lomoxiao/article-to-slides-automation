import type { MangaTreatment } from "../types/manga.js";
import { normalizeUrl, readFlagValue, sanitizeTextValue, tokenizeArgs } from "./slackArgTokens.js";

// Slack 経由(/manga スラッシュ・[manga-generate] メッセージ)の漫画生成引数を解釈する。
// CLI の parseMangaArgs と異なり、Slack 整形(<url>・スマートクォート)に対応し、
// 手打ち利用を想定して pages/画風/treatment に既定値を持たせる(フォームからは明示値が入る)。
//
// [manga-generate] --url https://a.com --pages 7 --art-style A
// /manga https://a.com           (後方互換: 素の URL を1件として受理)

export type MangaSlackArgs =
  | {
    ok: true;
    url: string;
    pages: number;
    genre?: string;
    artStyle: string;
    treatment: MangaTreatment;
    audience?: string;
    focus?: string;
  }
  | { ok: false; errorMessage: string };

export const DEFAULT_MANGA_PAGES = 5;
export const DEFAULT_MANGA_ART_STYLE = "F";
export const DEFAULT_MANGA_TREATMENT: MangaTreatment = "B";

const MANGA_GENERATE_PREFIX = "[manga-generate]";
const urlPattern = /https?:\/\/[^\s<>()]+/i;
const VALID_ART_STYLES = new Set(["A", "B", "C", "D", "E", "F", "G"]);
const VALID_TREATMENTS = new Set<MangaTreatment>(["A", "B", "C"]);
const supportedFlags = new Set([
  "--url",
  "--pages",
  "--genre",
  "--art-style",
  "--treatment",
  "--audience",
  "--focus"
]);

type ParsedOptions = {
  url?: string;
  pages?: string;
  genre?: string;
  artStyle?: string;
  treatment?: string;
  audience?: string;
  focus?: string;
  hasFlag: boolean;
};

export function parseMangaSlackArgs(text: string): MangaSlackArgs {
  const tokenizeResult = tokenizeArgs(text);
  if (!tokenizeResult.ok) {
    return tokenizeResult;
  }

  const tokens = tokenizeResult.tokens;
  const options: ParsedOptions = { hasFlag: tokens.some((token) => token.startsWith("--")) };
  const unconsumed: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "/manga" || token === MANGA_GENERATE_PREFIX) {
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
        options.url = value.trim();
        break;
      case "--pages":
        options.pages = value.trim();
        break;
      case "--genre":
        options.genre = sanitizeTextValue(value);
        break;
      case "--art-style":
        options.artStyle = value.trim();
        break;
      case "--treatment":
        options.treatment = value.trim();
        break;
      case "--audience":
        options.audience = sanitizeTextValue(value);
        break;
      case "--focus":
        options.focus = sanitizeTextValue(value);
        break;
    }

    index = nextIndex;
  }

  if (options.hasFlag && unconsumed.length > 0) {
    return { ok: false, errorMessage: `解釈できない引数があります: ${unconsumed.join(" ")}` };
  }

  // URL の確定(--url 優先、なければフラグ無しの素の URL を拾う)
  const rawUrl = options.url ?? (!options.hasFlag ? text.match(urlPattern)?.[0] : undefined);
  const url = rawUrl ? normalizeUrl(rawUrl) : "";
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, errorMessage: "`--url` に http(s) の URL を指定してください" };
  }

  const pagesResult = parsePages(options.pages);
  if (!pagesResult.ok) {
    return pagesResult;
  }

  const artStyle = (options.artStyle ?? DEFAULT_MANGA_ART_STYLE).toUpperCase();
  if (!VALID_ART_STYLES.has(artStyle)) {
    return { ok: false, errorMessage: "--art-style は A〜G のいずれかを指定してください" };
  }

  const treatment = (options.treatment ?? DEFAULT_MANGA_TREATMENT).toUpperCase() as MangaTreatment;
  if (!VALID_TREATMENTS.has(treatment)) {
    return {
      ok: false,
      errorMessage: "--treatment は A（原作忠実）/ B（脚色）/ C（完全創作）のいずれかを指定してください"
    };
  }

  return {
    ok: true,
    url,
    pages: pagesResult.pages,
    genre: options.genre,
    artStyle,
    treatment,
    audience: options.audience,
    focus: options.focus
  };
}

function parsePages(value: string | undefined): { ok: true; pages: number } | { ok: false; errorMessage: string } {
  if (value === undefined) {
    return { ok: true, pages: DEFAULT_MANGA_PAGES };
  }

  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    return { ok: false, errorMessage: "--pages には正の整数（総見開き数）を指定してください" };
  }

  return { ok: true, pages: Number(value) };
}
