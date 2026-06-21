import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { parseClaudeJson, spawnClaude } from "./claudeRunner.js";

export type MangaDeckFetchStatus = "fetched" | "pending" | "failed";

export type MangaDeckFetchResult = {
  status: MangaDeckFetchStatus;
  /** fetched のとき取得したベースURL(クエリ除去済み)。 */
  url?: string;
  /** 結果の説明(マーカー行など。ログ・通知に出す)。 */
  detail: string;
};

type FetchMangaDeckInput = {
  /** ログ・stdout の保存先(ジョブフォルダ)。 */
  jobDir: string;
  /** 操作対象ノートブック名。未指定なら config.MANGA_NOTEBOOKLM_NAME。 */
  notebookName?: string;
  logger?: (message: string) => void;
};

// notebookLmSync と同様、ブラウザ操作ツールは許可したいので disallowedTools には含めない。
// ファイル書込み・シェル等の破壊的ツールは禁止のまま残す。
const DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit"];

const URL_MARKER = "NBLM_DECK_URL:";
const PENDING_MARKER = "NBLM_DECK_PENDING";
const FAIL_MARKER = "NBLM_DECK_FAILED";

/**
 * 接続済み Chrome 経由で NotebookLM を操作し、固定ノートブックの Studio 最上位(=最新)
 * スライドデックの状態を1回だけ確認する。
 * - 完了済みなら「共有」→「リンクをコピー」→ クリップボード読み出しでベースURLを取得し fetched。
 * - まだ生成中なら pending。完了デックが無い/未ログイン/想定外は failed。
 * - 待機・リトライは呼び出し側(mangaDeckRetrieval)が制御する。本関数は単発の確認。
 * - 例外は投げず、status:"failed" として返す(呼び出し側で隔離・通知する想定)。
 *
 * 前提: ホストで Chrome 起動 + Claude in Chrome 拡張接続 + NotebookLM ログイン維持。
 */
export async function fetchMangaDeckUrl(input: FetchMangaDeckInput): Promise<MangaDeckFetchResult> {
  const log = input.logger ?? (() => {});
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
  const inputPath = path.join(input.jobDir, "claude-deckfetch-input.md");
  const stdoutPath = path.join(input.jobDir, "claude-deckfetch-stdout.json");
  const stderrPath = path.join(input.jobDir, "claude-deckfetch-stderr.log");
  await writeFile(inputPath, prompt, "utf8");

  try {
    const { exitCode, stdout, stderr } = await spawnClaude(args, prompt, config.MANGA_DECK_FETCH_TIMEOUT_MS);
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
    await writeFile(path.join(input.jobDir, "claude-deckfetch-error.log"), `${message}\n`, "utf8");
    return fail(log, error instanceof Error ? error.message : String(error));
  }
}

/** 応答テキストのマーカー行から status を判定する。 */
function classify(log: (m: string) => void, result: string, stdoutPath: string): MangaDeckFetchResult {
  const markerLine = extractMarkerLine(result);

  if (markerLine?.startsWith(URL_MARKER)) {
    const raw = markerLine.slice(URL_MARKER.length).trim();
    // 防御的にクエリ(utm 等)を除去。クエリ文字列はエージェント出力フィルタに弾かれうるため、
    // プロンプト側でも除去を指示しているが、念のため Node 側でも切り落とす。
    const url = raw.split("?")[0]?.trim() ?? "";
    if (!/^https?:\/\//i.test(url)) {
      return fail(log, `デックURLの形式が不正です: ${raw}。See ${stdoutPath}`);
    }
    log(`NotebookLM: デックURLを取得しました (${url})`);
    return { status: "fetched", url, detail: markerLine };
  }
  if (markerLine?.startsWith(PENDING_MARKER)) {
    log("NotebookLM: スライドデックはまだ生成中です");
    return { status: "pending", detail: markerLine };
  }
  if (markerLine?.startsWith(FAIL_MARKER)) {
    return fail(log, markerLine);
  }

  // マーカーが見つからない = 想定外の終わり方。安全側で failed 扱い(成功と誤通知しない)。
  return fail(log, `デックURL取得の結果を判定できませんでした(マーカー行なし)。See ${stdoutPath}`);
}

function extractMarkerLine(result: string): string | undefined {
  const lines = result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // 末尾から最初に見つかったマーカー行を採用する。
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.startsWith(URL_MARKER) || line.startsWith(PENDING_MARKER) || line.startsWith(FAIL_MARKER)) {
      return line;
    }
  }
  return undefined;
}

function fail(log: (m: string) => void, detail: string): MangaDeckFetchResult {
  log(`NotebookLM: デックURL取得失敗 (${detail})`);
  return { status: "failed", detail };
}

function buildPrompt(notebookName: string): string {
  return [
    "あなたは接続済みの Google Chrome で NotebookLM を操作するエージェントです。",
    "以下の手順を上から順に、正確に、指示された操作のみ実行してください。勝手なクリックや余計な操作は禁止です。",
    "目的は「Studio 最上位(最新)のスライドデックの状態を確認し、完了していれば共有URLを取得する」ことです。",
    "",
    "手順:",
    "1. https://notebooklm.google.com を開く。",
    `2. ノートブック一覧から「${notebookName}」という名前のノートブックを開く。`,
    "3. 画面右側の「Studio」パネルを表示する。",
    "4. Studio 内で、最上位(=最新)にあるスライドデックの成果物を特定する。",
    "5. そのデックがまだ「生成中 / 作成中 / 処理中」(プログレス表示で開けない/共有できない)であれば、",
    "   余計な操作をせず、最後の行に「NBLM_DECK_PENDING」とだけ出力して終了する。",
    "6. デックが生成完了している(開ける/共有できる)場合のみ次に進む:",
    "   a. そのデックの「共有」メニュー/ボタンを開く。",
    "   b. 「リンクをコピー」または「コピー」を押して共有URLをクリップボードにコピーする。",
    "   c. navigator.clipboard.readText() に相当する方法でクリップボードのテキストを取得する。",
    "   d. 取得したURLから「?」以降のクエリ文字列(utm_* など)を取り除き、ベースURL",
    "      (https://notebooklm.google.com/notebook/<id>/artifact/<id> の形)だけにする。",
    "      ※ クエリ文字列を付けたまま出力すると出力フィルタに弾かれるため、必ず「?」以降は除くこと。",
    "   e. 最後の行に「NBLM_DECK_URL: <ベースURL>」とだけ出力する。",
    "7. 完了済みのスライドデックが1件も無い、未ログイン、要素が見つからない等で続行できない場合は、",
    "   最後の行に「NBLM_DECK_FAILED: <理由>」と出力する。",
    "",
    "出力の最後の行は必ず NBLM_DECK_URL / NBLM_DECK_PENDING / NBLM_DECK_FAILED のいずれかにすること。"
  ].join("\n");
}
