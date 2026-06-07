import type { MangaTreatment } from "../types/manga.js";

export type MangaArgs =
  | {
      ok: true;
      url: string;
      pages: number;
      genre?: string;
      artStyle: string;
      treatment: MangaTreatment;
      audience?: string;
      focus?: string;
      /** キャラクターシート画像の入力ディレクトリ(未指定なら既定の manga-templates/character-sheets)。 */
      characterSheetsDir?: string;
    }
  | { ok: false; errorMessage: string };

// tsx src/scripts/articleToMangaOutline.ts --url https://... --pages 8 --genre 教育・解説 --art-style A
//   -> { ok: true, url, pages: 8, genre: "教育・解説", artStyle: "A", treatment: "B" }
//
// --art-style 未指定なら F(絵本風)、--treatment 未指定なら B(脚色)。

const supportedFlags = new Set([
  "--url",
  "--pages",
  "--genre",
  "--art-style",
  "--treatment",
  "--audience",
  "--focus",
  "--character-sheets"
]);

const VALID_ART_STYLES = new Set(["A", "B", "C", "D", "E", "F", "G"]);
const VALID_TREATMENTS = new Set<MangaTreatment>(["A", "B", "C"]);

export function parseMangaArgs(tokens: string[]): MangaArgs {
  const options: Record<string, string> = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      return { ok: false, errorMessage: `解釈できない引数です: ${token}` };
    }
    if (!supportedFlags.has(token)) {
      return { ok: false, errorMessage: `未対応の引数です: ${token}` };
    }

    const values: string[] = [];
    let next = index + 1;
    while (next < tokens.length && !tokens[next].startsWith("--")) {
      values.push(tokens[next]);
      next += 1;
    }
    const value = values.join(" ").trim();
    if (!value) {
      return { ok: false, errorMessage: `${token} の値を指定してください` };
    }
    options[token] = value;
    index = next - 1;
  }

  const url = options["--url"];
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, errorMessage: "--url に http(s) の URL を指定してください" };
  }

  const pagesRaw = options["--pages"];
  if (!pagesRaw || !/^\d+$/.test(pagesRaw) || Number(pagesRaw) <= 0) {
    return { ok: false, errorMessage: "--pages に正の整数（総見開き数）を指定してください" };
  }

  const artStyle = (options["--art-style"] ?? "F").toUpperCase();
  if (!VALID_ART_STYLES.has(artStyle)) {
    return { ok: false, errorMessage: "--art-style は A〜G のいずれかを指定してください" };
  }

  const treatment = (options["--treatment"] ?? "B").toUpperCase() as MangaTreatment;
  if (!VALID_TREATMENTS.has(treatment)) {
    return { ok: false, errorMessage: "--treatment は A（原作忠実）/ B（脚色）/ C（完全創作）のいずれかを指定してください" };
  }

  return {
    ok: true,
    url,
    pages: Number(pagesRaw),
    genre: options["--genre"],
    artStyle,
    treatment,
    audience: options["--audience"],
    focus: options["--focus"],
    characterSheetsDir: options["--character-sheets"]
  };
}
