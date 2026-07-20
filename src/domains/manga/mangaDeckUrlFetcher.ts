import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { ClaudeTimeoutError, parseClaudeJson, spawnClaude } from "../../shared/claudeRunner.js";

export type MangaDeckFetchStatus = "fetched" | "pending" | "generation_failed" | "retrieval_failed";

export type MangaDeckFetchResult = {
  status: MangaDeckFetchStatus;
  /** fetched のとき取得したベースURL(クエリ除去済み)。 */
  url?: string;
  /** 結果の説明(マーカー行など。ログ・通知に出す)。 */
  detail: string;
  /** 一時的なChrome接続失敗など、同じジョブ内で再試行してよい失敗。 */
  retryable?: boolean;
};

type FetchMangaDeckInput = {
  /** ログ・stdout の保存先(ジョブフォルダ)。 */
  jobDir: string;
  /** 操作対象ノートブック名。未指定なら config.manga.notebookLmName。 */
  notebookName?: string;
  logger?: (message: string) => void;
};

// notebookLmSync と同様、ブラウザ操作ツールは許可したいので disallowedTools には含めない。
// ファイル書込み・シェル等の破壊的ツールは禁止のまま残す。
const DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit"];

const URL_MARKER = "NBLM_DECK_URL:";
const PENDING_MARKER = "NBLM_DECK_PENDING";
const GENERATION_FAIL_MARKER = "NBLM_DECK_GENERATION_FAILED";
const RETRIEVAL_FAIL_MARKER = "NBLM_DECK_URL_FAILED";
const SHORT_RETRIEVAL_FAIL_MARKER = "NBLM_URL_FAILED";
const LEGACY_FAIL_MARKER = "NBLM_DECK_FAILED";

/**
 * 接続済み Chrome 経由で NotebookLM を操作し、固定ノートブックの Studio 最上位(=最新)
 * スライドデックの状態を1回だけ確認する。
 * - 完了済みならノートブックIDと成果物要素のIDからベースURLを構築し fetched。
 * - まだ生成中なら pending。完了デックが無い/未ログイン/想定外は failed。
 * - 待機・リトライは呼び出し側(notebookLmPipeline のフォールバック経路)が制御する。本関数は単発の確認。
 * - 例外は投げず、status:"failed" として返す(呼び出し側で隔離・通知する想定)。
 *
 * 前提: ホストで Chrome 起動 + Claude in Chrome 拡張接続 + NotebookLM ログイン維持。
 */
export async function fetchMangaDeckUrl(input: FetchMangaDeckInput): Promise<MangaDeckFetchResult> {
  const log = input.logger ?? (() => {});
  const notebookName = input.notebookName ?? config.manga.notebookLmName;
  const sessionId = randomUUID();

  const args = [
    "-p",
    "--output-format",
    "json",
    "--chrome",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    config.claude.model,
    "--max-turns",
    String(config.manga.deckFetchMaxTurns),
    "--session-id",
    sessionId,
    "--disallowedTools",
    ...DISALLOWED_TOOLS
  ];

  const prompt = buildMangaDeckFetchPrompt(notebookName);
  const inputPath = path.join(input.jobDir, "claude-deckfetch-input.md");
  const stdoutPath = path.join(input.jobDir, "claude-deckfetch-stdout.json");
  const stderrPath = path.join(input.jobDir, "claude-deckfetch-stderr.log");
  await writeFile(inputPath, prompt, "utf8");

  try {
    const { exitCode, stdout, stderr } = await spawnClaude(args, prompt, config.manga.deckFetchTimeoutMs);
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");

    if (exitCode !== 0) {
      const detail = `claude --chrome がコード ${exitCode} で終了しました (session=${sessionId})。See ${stderrPath}`;
      return retrievalFail(log, detail, isTransientChromeFailure(`${stdout}\n${stderr}`));
    }

    const parsed = parseClaudeJson(stdout);
    if (parsed.is_error) {
      const detail = `claude --chrome がエラーを返しました (${parsed.subtype ?? "unknown"}, session=${sessionId})。See ${stdoutPath}`;
      return retrievalFail(log, detail, isTransientChromeFailure(stdout));
    }

    const result = typeof parsed.result === "string" ? parsed.result : "";
    return classifyMangaDeckFetchResult(log, result, stdoutPath);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeFile(path.join(input.jobDir, "claude-deckfetch-error.log"), `${message}\nsessionId=${sessionId}\n`, "utf8");
    if (error instanceof ClaudeTimeoutError) {
      await Promise.all([
        writeFile(path.join(input.jobDir, "claude-deckfetch-stdout.partial.log"), error.stdout, "utf8"),
        writeFile(path.join(input.jobDir, "claude-deckfetch-stderr.partial.log"), error.stderr, "utf8")
      ]);
      return retrievalFail(log, `${error.message} (session=${sessionId})`, true);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return retrievalFail(log, `${detail} (session=${sessionId})`, isTransientChromeFailure(detail));
  }
}

/** 応答テキストのマーカー行から status を判定する。 */
export function classifyMangaDeckFetchResult(
  log: (m: string) => void,
  result: string,
  stdoutPath: string
): MangaDeckFetchResult {
  const markerLine = extractMarkerLine(result);

  if (markerLine?.startsWith(URL_MARKER)) {
    const raw = markerLine.slice(URL_MARKER.length).trim();
    const url = normalizeNotebookLmArtifactUrl(raw);
    if (!url) {
      return retrievalFail(log, `デックURLの形式が不正です: ${raw}。See ${stdoutPath}`);
    }
    log(`NotebookLM: デックURLを取得しました (${url})`);
    return { status: "fetched", url, detail: markerLine };
  }
  if (markerLine?.startsWith(PENDING_MARKER)) {
    log("NotebookLM: スライドデックはまだ生成中です");
    return { status: "pending", detail: markerLine };
  }
  if (markerLine?.startsWith(GENERATION_FAIL_MARKER)) {
    return generationFail(log, markerLine);
  }
  if (
    markerLine?.startsWith(RETRIEVAL_FAIL_MARKER) ||
    markerLine?.startsWith(SHORT_RETRIEVAL_FAIL_MARKER) ||
    markerLine?.startsWith(LEGACY_FAIL_MARKER)
  ) {
    return retrievalFail(log, markerLine);
  }

  // マーカーが見つからない = 想定外の終わり方。安全側で failed 扱い(成功と誤通知しない)。
  return retrievalFail(log, `デックURL取得の結果を判定できませんでした(マーカー行なし)。See ${stdoutPath}`);
}

function extractMarkerLine(result: string): string | undefined {
  const lines = result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // 末尾から最初に見つかったマーカー行を採用する。
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (
      line.startsWith(URL_MARKER) ||
      line.startsWith(PENDING_MARKER) ||
      line.startsWith(GENERATION_FAIL_MARKER) ||
      line.startsWith(RETRIEVAL_FAIL_MARKER) ||
      line.startsWith(SHORT_RETRIEVAL_FAIL_MARKER) ||
      line.startsWith(LEGACY_FAIL_MARKER)
    ) {
      return line;
    }
  }
  return undefined;
}

function generationFail(log: (m: string) => void, detail: string): MangaDeckFetchResult {
  log(`NotebookLM: スライドデック生成失敗 (${detail})`);
  return { status: "generation_failed", detail };
}

function retrievalFail(log: (m: string) => void, detail: string, retryable = false): MangaDeckFetchResult {
  log(`NotebookLM: デックURL取得失敗 (${detail})`);
  return { status: "retrieval_failed", detail, ...(retryable ? { retryable: true } : {}) };
}

export function normalizeNotebookLmArtifactUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    if (
      url.protocol !== "https:" ||
      url.hostname !== "notebooklm.google.com" ||
      !new RegExp(`^/notebook/${uuid}/artifact/${uuid}/?$`, "i").test(url.pathname)
    ) {
      return undefined;
    }
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isTransientChromeFailure(text: string): boolean {
  return /(?:browser extension|claude in chrome).*(?:not connected|unavailable)|tool call timed out|connection.*closed|error_max_turns|maximum number of turns|reached max turns/i.test(
    text
  );
}

export function shouldRetryMangaDeckFetch(result: MangaDeckFetchResult): boolean {
  return result.status === "pending" || result.retryable === true;
}

export const MANGA_DECK_DOM_SCRIPT = String.raw`const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const notebookMatch = location.pathname.match(new RegExp("^/notebook/(" + uuid + ")", "i"));
let result = null;

if (!notebookMatch) {
  result = { status: "url_failed", reason: "NotebookLMのノートブックURLが開かれていません" };
}

let firstItem = document.querySelector("artifact-library-item");
let labelledElement = firstItem?.querySelector('[aria-labelledby^="artifact-labels-"]')
  ?? document.querySelector('[aria-labelledby^="artifact-labels-"]');

if (!result && !labelledElement) {
  let studioTab = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    studioTab = [...document.querySelectorAll('[role="tab"], button')]
      .find((tab) => tab.textContent?.trim() === "Studio");
    if (studioTab) break;
    await sleep(250);
  }
  if (!studioTab) {
    result = { status: "url_failed", reason: "Studioタブが見つかりません" };
  } else if (studioTab.getAttribute("aria-selected") !== "true") {
    studioTab.click();
  }
}

if (!result) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    firstItem = document.querySelector("artifact-library-item");
    labelledElement = firstItem?.querySelector('[aria-labelledby^="artifact-labels-"]')
      ?? document.querySelector('[aria-labelledby^="artifact-labels-"]');
    if (labelledElement) break;
    await sleep(250);
  }
}

if (!result && !labelledElement) {
  const pageText = document.body?.innerText ?? "";
  if (/(生成中|作成中|処理中)/.test(pageText)) {
    result = { status: "pending" };
  } else if (/(生成に失敗|生成エラー)/.test(pageText)) {
    result = { status: "generation_failed", reason: "画面に生成失敗が表示されています" };
  } else {
    result = { status: "url_failed", reason: "最新成果物のaria-labelledbyが見つかりません" };
  }
}

if (!result && labelledElement) {
  const labelledBy = labelledElement.getAttribute("aria-labelledby") ?? "";
  const artifactMatch = labelledBy.match(new RegExp("^artifact-labels-(" + uuid + ")$", "i"));
  if (!artifactMatch) {
    const itemText = firstItem?.textContent ?? labelledElement.textContent ?? "";
    if (/(生成中|作成中|処理中)/.test(itemText)) {
      result = { status: "pending" };
    } else if (/(生成に失敗|生成エラー)/.test(itemText)) {
      result = { status: "generation_failed", reason: itemText.trim().slice(0, 200) };
    } else {
      result = { status: "url_failed", reason: "最新成果物のartifact IDが見つかりません" };
    }
  } else {
    result = {
      status: "ready",
      url: "https://notebooklm.google.com/notebook/" + notebookMatch[1] + "/artifact/" + artifactMatch[1]
    };
  }
}

JSON.stringify(result);`;

export function buildMangaDeckFetchPrompt(notebookName: string): string {
  return [
    "あなたは接続済みの Google Chrome で NotebookLM を操作するエージェントです。",
    `対象ノートブックは「${notebookName}」です。`,
    "tabs_context_mcpを1回だけ実行し、既に開いているNotebookLMの /notebook/<UUID> タブIDを取得してください。",
    "次にjavascript_toolをaction=javascript_execで1回だけ実行してください。textには下記コードを一字も変更せず指定します。",
    "read_page、find、navigate、追加のJavaScript、共有操作、Clipboard API、DOM探索は禁止です。",
    "",
    MANGA_DECK_DOM_SCRIPT,
    "",
    "JavaScriptの返却値だけを次の規則で変換し、対応する1行だけを出力して終了してください。",
    "ready: NBLM_DECK_URL: <url>",
    "pending: NBLM_DECK_PENDING",
    "generation_failed: NBLM_DECK_GENERATION_FAILED: <reason>",
    "url_failed: NBLM_DECK_URL_FAILED: <reason>",
    "返却後の確認、説明、追加ツール呼び出しは禁止です。"
  ].join("\n");
}
