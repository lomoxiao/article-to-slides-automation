// Slack メッセージ/スラッシュコマンドの引数テキストを解釈するための共通ヘルパ。
// parseSlideArgs と parseMangaSlackArgs で共有する(トークン分割・URL正規化・テキスト整形)。

export type TokenizeResult =
  | { ok: true; tokens: string[] }
  | { ok: false; errorMessage: string };

/** ダブルクォート対応の簡易トークナイザ。クォート内の空白は1トークンに保持する。 */
export function tokenizeArgs(text: string): TokenizeResult {
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

/** Slack のリンク装飾(`<url|label>`)を剥がし、末尾の句読点等を除去した URL を返す。 */
export function normalizeUrl(value: string): string {
  const slackLink = value.trim().match(/^<((?:https?:\/\/)[^>|]+)(?:\|[^>]*)?>$/);
  const url = slackLink?.[1] ?? value.trim();
  return url.replace(/[.,;:!?)}\]>]+$/u, "");
}

/** 自由記述値から Slack リンク装飾を除き、空白を正規化する。 */
export function sanitizeTextValue(value: string): string {
  return value
    .replace(/<https?:\/\/[^>|]+\|([^>]*)>/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** フラグ直後から次のフラグ直前までを値として連結して返す。 */
export function readFlagValue(tokens: string[], flagIndex: number): { value: string; nextIndex: number } {
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
