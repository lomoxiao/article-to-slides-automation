// Slack メッセージイベントの受理判定・整形(純粋ロジック)。
// Socket Mode との接続・ハンドラ登録・通知 I/O は socketModeClient.ts の責務。

export const SLIDE_GENERATE_PREFIX = "[slide-generate]";
export const MANGA_GENERATE_PREFIX = "[manga-generate]";

export type SlackMessageEvent = {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  ts?: string;
  client_msg_id?: string;
};

/** 指定プレフィックスで始まる生成依頼メッセージか(チャンネル・subtype 制約込み)。 */
export function isGenerateMessage(
  event: SlackMessageEvent | undefined,
  prefix: string,
  completionChannelId: string | undefined
): boolean {
  if (!event || event.type !== "message") {
    return false;
  }

  const text = event.text?.trim();
  if (!text?.startsWith(prefix)) {
    return false;
  }

  if (!event.channel || !isChannelAllowed(event.channel, completionChannelId)) {
    return false;
  }

  if (event.subtype && event.subtype !== "bot_message") {
    return false;
  }

  return true;
}

export function stripPrefix(text: string, prefix: string) {
  const trimmed = text.trim();
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
}

/** 完了通知チャンネルが未設定 or サンプル値(C0000...)なら全チャンネル許可(開発時の既定)。 */
export function isChannelAllowed(channelId: string, completionChannelId: string | undefined) {
  if (isSampleChannelId(completionChannelId)) {
    return true;
  }

  return completionChannelId === channelId;
}

function isSampleChannelId(id: string | undefined): boolean {
  if (!id) {
    return true;
  }

  return /^C0{4,}/i.test(id);
}

/** 再送 dedup 用のリクエストID。client_msg_id が無ければ channel:ts で代替する。 */
export function getRequestId(event: SlackMessageEvent) {
  return event.client_msg_id ?? `${event.channel ?? "unknown"}:${event.ts ?? "unknown"}`;
}

export function describeSlackMessageEvent(event: SlackMessageEvent | undefined): string {
  if (!event) {
    return "event=none";
  }

  return [
    `type=${event.type ?? "unknown"}`,
    `channel=${event.channel ?? "unknown"}`,
    `ts=${event.ts ?? "unknown"}`,
    `subtype=${event.subtype ?? "none"}`,
    `text=${JSON.stringify(previewText(event.text))}`
  ].join(" ");
}

export function previewText(text: string | undefined): string {
  const trimmed = text?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}...` : trimmed;
}

export function getErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }

  return "unknown";
}
