import { config } from "../../config.js";
import { postSlackText } from "../../shared/slackNotifier.js";
import type { DriverFailure, NotebookLmSession } from "./notebookLmDriver.js";

// Phase3(notebookLmPipeline) と Phase4(notebookLmDeckRetrieval) で共有する定数・小道具。

export const NBLM_SESSION_DOMAIN = "notebooklm.google.com";

// timeout/unreachable でのドライバ再起動リトライ上限(初回含めた試行数ではなく追加リトライ数)。
export const DRIVER_RESTART_RETRIES = 2;
// 「現在、回答できません」時の再送バックオフ(分)。MANGA_NBLM_CHAT_RETRIES 回まで先頭から使う。
const CHAT_RETRY_BACKOFF_MIN = [2, 4, 8];

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** チャット送信。「現在、回答できません」はバックオフ(2/4/8分)+reload+再送で最大 N 回リトライする。 */
export async function triggerStep3WithRetries(
  session: NotebookLmSession,
  log: (message: string) => void
): Promise<{ ok: true } | { ok: false; failure: DriverFailure }> {
  let lastFailure: DriverFailure | undefined;
  for (let attempt = 0; attempt <= config.manga.nblmChatRetries; attempt += 1) {
    if (attempt > 0) {
      const backoffMin = CHAT_RETRY_BACKOFF_MIN[Math.min(attempt - 1, CHAT_RETRY_BACKOFF_MIN.length - 1)];
      log(`NotebookLM: 回答不能応答のため ${backoffMin} 分待機して再送します (${attempt}/${config.manga.nblmChatRetries})`);
      await sleep(backoffMin * 60_000);
      const reloaded = await session.reload();
      if (!reloaded.ok) return reloaded;
    }
    const result = await session.triggerStep3();
    if (result.ok) return { ok: true };
    if (result.failure.kind !== "nblm_unavailable") return result;
    lastFailure = result.failure;
  }
  return { ok: false, failure: lastFailure as DriverFailure };
}

/** ui_mismatch フォールバック発動を Slack に通知し、恒常運用化(セレクタ放置)を防ぐ。 */
export async function notifyUiFallback(phase: string, detail: string, log: (message: string) => void): Promise<void> {
  log(`NotebookLM: ${phase} で ui_mismatch。claude --chrome へフォールバックします`);
  await postSlackText({
    text:
      `⚠️ NotebookLM ${phase} でセレクタ不一致を検出し、claude --chrome へフォールバックしました。\n` +
      `NotebookLM の UI が変わった可能性があります。\`npm run notebooklm:probe\` で確認・修理してください。\n` +
      `詳細: ${detail}`
  }).catch((e) => log(`Slack 通知に失敗: ${e}`));
}
