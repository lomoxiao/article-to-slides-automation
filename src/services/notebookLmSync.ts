import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { parseClaudeJson, spawnClaude } from "./claudeRunner.js";

export type NotebookLmSyncStatus = "executed" | "skipped" | "failed";

export type NotebookLmSyncResult = {
  status: NotebookLmSyncStatus;
  /** 結果の説明(マーカー行など。通知やログに出す)。 */
  detail: string;
};

type SyncNotebookLmInput = {
  /** ログ・stdout の保存先(ジョブフォルダ)。 */
  jobDir: string;
  /** 操作対象ノートブック名。未指定なら config.MANGA_NOTEBOOKLM_NAME。 */
  notebookName?: string;
  logger?: (message: string) => void;
};

// ブラウザ操作セッション。Claude in Chrome のブラウザ操作ツールは許可したいので
// disallowedTools には含めない。一方でファイル書込み・シェル等の破壊的ツールは禁止のまま残す。
const DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit"];

const DONE_MARKER = "NOTEBOOKLM_DONE";
const FAIL_MARKER = "NOTEBOOKLM_FAILED";

/**
 * 接続済み Chrome 経由で NotebookLM を操作し、固定ノートブックの step1/step2 ソースを開いて
 * Drive 同期の反映を促したうえでチャットに「ステップ３を実行して」を投稿する。
 *
 * 前提: ホストで Chrome 起動 + Claude in Chrome 拡張接続 + NotebookLM ログイン維持。
 * - `claude -p --chrome --permission-mode bypassPermissions` で非対話・操作確認なしに動かす。
 * - ソース側に「Googleドライブと同期」等の更新操作が出た場合は、実行して完了を待つ。
 * - チャット応答を確認できたら executed。続行不能・想定外出力は failed。
 * - 例外は投げず、status:"failed" として返す(呼び出し側で隔離・通知する想定)。
 */
export async function syncNotebookLm(input: SyncNotebookLmInput): Promise<NotebookLmSyncResult> {
  const log = input.logger ?? (() => { });
  const notebookName = input.notebookName ?? config.MANGA_NOTEBOOKLM_NAME;

  const args = [
    "-p",
    "--output-format",
    "json",
    "--chrome",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    config.CLAUDE_MODEL,
    "--disallowedTools",
    ...DISALLOWED_TOOLS
  ];

  const prompt = buildPrompt(notebookName);
  const inputPath = path.join(input.jobDir, "claude-notebooklm-input.md");
  const stdoutPath = path.join(input.jobDir, "claude-notebooklm-stdout.json");
  const stderrPath = path.join(input.jobDir, "claude-notebooklm-stderr.log");
  await writeFile(inputPath, prompt, "utf8");

  try {
    const { exitCode, stdout, stderr } = await spawnClaude(args, prompt, config.MANGA_NOTEBOOKLM_TIMEOUT_MS);
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");

    if (exitCode !== 0) {
      return fail(log, `claude --chrome がコード ${exitCode} で終了しました。See ${stderrPath}`);
    }

    const parsed = parseClaudeJson(stdout);
    if (parsed.is_error) {
      return fail(log, `claude --chrome がエラーを返しました (${parsed.subtype ?? "unknown"})。See ${stdoutPath}`);
    }

    const result = typeof parsed.result === "string" ? parsed.result : "";
    return classify(log, result, stdoutPath);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeFile(path.join(input.jobDir, "claude-notebooklm-error.log"), `${message}\n`, "utf8");
    return fail(log, error instanceof Error ? error.message : String(error));
  }
}

/** 応答テキストのマーカー行から status を判定する。 */
function classify(log: (m: string) => void, result: string, stdoutPath: string): NotebookLmSyncResult {
  const markerLine = extractMarkerLine(result);

  if (markerLine?.startsWith(FAIL_MARKER)) {
    return fail(log, markerLine);
  }
  if (markerLine?.startsWith(DONE_MARKER)) {
    log("NotebookLM: Step3 を実行しました");
    return { status: "executed", detail: markerLine };
  }

  // マーカーが見つからない = 想定外の終わり方。安全側で failed 扱い(成功と誤通知しない)。
  return fail(log, `NotebookLM 操作の結果を判定できませんでした(マーカー行なし)。See ${stdoutPath}`);
}

function extractMarkerLine(result: string): string | undefined {
  const lines = result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // 末尾から最初に見つかったマーカー行を採用する。
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.startsWith(DONE_MARKER) || line.startsWith(FAIL_MARKER)) {
      return line;
    }
  }
  return undefined;
}

function fail(log: (m: string) => void, detail: string): NotebookLmSyncResult {
  log(`NotebookLM: 失敗 (${detail})`);
  return { status: "failed", detail };
}

function buildPrompt(notebookName: string): string {
  return [
    "あなたは接続済みの Google Chrome で NotebookLM を操作するエージェントです。",
    "以下の手順を上から順に、正確に、指示された操作のみ実行してください。勝手なクリックや余計な操作は禁止です。",
    "",
    "手順:",
    "1. https://notebooklm.google.com を開く。",
    `2. ノートブック一覧から「${notebookName}」という名前のノートブックを開く。`,
    "3. 左ペインのソース一覧から「step1-output」をクリックして、ソースガイドが表示されることを確認する",
    "   ※ 「クリックして Googleドライブと同期」などの更新操作が表示された場合はクリックして実行する",
    "4. 左ペインのソース一覧に戻り、「step2-output」をクリックして、ソースガイドが表示されることを確認する",
    "   ※ 「クリックして Googleドライブと同期」などの更新操作が表示された場合はクリックして実行する",
    "5. チャット入力欄に「ステップ３を実行して」と入力して送信する。",
    "6. チャットに応答(生成開始や返信)が表示されたことを確認する。",
    "7. 応答を確認できたら、最後の行に「NOTEBOOKLM_DONE」とだけ出力する。",
    "",
    "途中で要素が見つからない、未ログイン等で続行できない場合は、最後の行に「NOTEBOOKLM_FAILED: <理由>」と出力する。",
    "出力の最後の行は必ず NOTEBOOKLM_DONE / NOTEBOOKLM_FAILED のいずれかにすること。"
  ].join("\n");
}
