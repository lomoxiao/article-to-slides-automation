/**
 * 記事本文を取得できなかったことを表す型付きエラー。
 * 生成側(スライド/漫画/動画)はこれを「失敗」ではなく、利用者の対応待ち(action_required)として扱う。
 * 他の型付きエラー(SessionExpiredError)と同様、モジュール境界をまたいでも判定できるよう name で見分ける。
 */
export class SourceUnavailableError extends Error {
  readonly url: string;
  /** http_403 / http_404 / http_other / timeout / network / other / too_short / no_transcript / empty */
  readonly reason: string;

  constructor(url: string, reason: string, message: string) {
    super(message);
    this.name = "SourceUnavailableError";
    this.url = url;
    this.reason = reason;
  }
}

export const SOURCE_UNAVAILABLE_CODE = "SOURCE_UNAVAILABLE";
export const SOURCE_UNAVAILABLE_PREFIX = "本文が取れていません";

export function isSourceUnavailableError(error: unknown): error is SourceUnavailableError {
  return error instanceof Error && error.name === "SourceUnavailableError";
}

const REASON_TEXT: Record<string, string> = {
  http_403: "サイトに取得を拒否されました",
  http_404: "ページが見つかりません",
  http_other: "サイトがエラーを返しました",
  timeout: "サイトの応答が時間内に返りませんでした",
  network: "サイトに接続できませんでした",
  other: "取得中にエラーが発生しました",
  too_short: "本文がほとんど取得できませんでした",
  no_transcript: "字幕を取得できませんでした",
  empty: "投稿の本文を取得できませんでした"
};

/** 利用者向けの説明文。Viewer の statusMessage と Slack 通知にそのまま出す。 */
export function describeSourceFailure(reason: string, detail?: { chars?: number; status?: number }): string {
  const base = REASON_TEXT[reason] ?? REASON_TEXT.other;
  const suffix =
    reason === "too_short" && detail?.chars !== undefined
      ? `・${detail.chars}文字`
      : reason === "http_other" && detail?.status !== undefined
        ? `・HTTP ${detail.status}`
        : "";
  return `${SOURCE_UNAVAILABLE_PREFIX}（${base}${suffix}）。記事をコピーして、テキスト投入をお試しください。`;
}
