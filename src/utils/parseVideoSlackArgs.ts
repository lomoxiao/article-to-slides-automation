import { normalizeUrl, readFlagValue, sanitizeTextValue, tokenizeArgs } from "./slackArgTokens.js";

export type VideoSlackArgs =
  | { ok: true; url: string; audience?: string; focus?: string; motionMode?: "basic" | "rich" }
  | { ok: false; errorMessage: string };

export function parseVideoSlackArgs(text: string): VideoSlackArgs {
  const tokenized = tokenizeArgs(text);
  if (!tokenized.ok) return tokenized;
  const options: { url?: string; audience?: string; focus?: string; motionMode?: "basic" | "rich" } = {};
  const unconsumed: string[] = [];
  for (let index = 0; index < tokenized.tokens.length; index += 1) {
    const token = tokenized.tokens[index];
    if (token === "[video-generate]" || token === "/video") continue;
    if (!token.startsWith("--")) {
      unconsumed.push(token);
      continue;
    }
    if (!["--url", "--audience", "--focus", "--motion"].includes(token)) {
      return { ok: false, errorMessage: `未対応の引数です: ${token}` };
    }
    const value = readFlagValue(tokenized.tokens, index);
    if (!value.value) return { ok: false, errorMessage: `${token} の値を指定してください` };
    if (token === "--url") options.url = value.value;
    if (token === "--audience") options.audience = sanitizeTextValue(value.value);
    if (token === "--focus") options.focus = sanitizeTextValue(value.value);
    if (token === "--motion") {
      if (value.value !== "basic" && value.value !== "rich") return { ok: false, errorMessage: "--motion must be basic or rich" };
      options.motionMode = value.value;
    }
    index = value.nextIndex;
  }
  const rawUrl = options.url ?? (unconsumed.length === 1 ? unconsumed[0] : undefined);
  const url = rawUrl ? normalizeUrl(rawUrl) : "";
  if (!/^https?:\/\//i.test(url)) return { ok: false, errorMessage: "`--url` に http(s) の URL を指定してください" };
  return { ok: true, url, audience: options.audience, focus: options.focus, ...(options.motionMode ? { motionMode: options.motionMode } : {}) };
}
