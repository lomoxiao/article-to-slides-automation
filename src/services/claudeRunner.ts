import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export type ClaudeRunResult = {
  result: string;
  sessionId: string;
  raw: string;
};

type RunClaudeInput = {
  /** stdin に流すプロンプト本文(指示・ソース・画風などを全て内包させる)。 */
  prompt: string;
  /** ログ出力先(ジョブフォルダ)。 */
  jobDir: string;
  /** ログファイル名の接頭辞(例: "step1")。 */
  logLabel: string;
  /** 新規セッションに固定の ID を割り当てる(後続ターンの resume 用)。 */
  sessionId?: string;
  /** 既存セッションを継続する場合の ID。sessionId とは排他。 */
  resumeSessionId?: string;
  /** モデル別名 or 正式名。未指定なら config.CLAUDE_MODEL。 */
  model?: string;
};

// 生成専用タスクなので Claude にツールを使わせない(誤って WebFetch / 書込み等を走らせないため)。
const DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "NotebookEdit"
];

/**
 * Claude Code を `claude -p`(ヘッドレス/print モード)で起動し、応答テキストを取得する。
 * - ログイン済み CLI のサブスク認証で動作する(ANTHROPIC_API_KEY 不要)。
 * - 出力は `--output-format json` でパースし、result(本文)と session_id(継続用)を返す。
 * - codexRunner と同様にサブプロセス実行。プロンプトは stdin から渡す。
 */
export async function runClaudeHeadless(input: RunClaudeInput): Promise<ClaudeRunResult> {
  if (input.sessionId && input.resumeSessionId) {
    throw new Error("sessionId と resumeSessionId は同時に指定できません");
  }

  const model = input.model ?? config.CLAUDE_MODEL;
  const args = ["-p", "--output-format", "json", "--model", model, "--disallowedTools", ...DISALLOWED_TOOLS];

  if (input.sessionId) {
    args.push("--session-id", input.sessionId);
  }
  if (input.resumeSessionId) {
    args.push("-r", input.resumeSessionId);
  }

  const inputPath = path.join(input.jobDir, `claude-${input.logLabel}-input.md`);
  const stdoutPath = path.join(input.jobDir, `claude-${input.logLabel}-stdout.json`);
  const stderrPath = path.join(input.jobDir, `claude-${input.logLabel}-stderr.log`);
  await writeFile(inputPath, input.prompt, "utf8");

  try {
    const { exitCode, stdout, stderr } = await spawnClaude(args, input.prompt);
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");

    if (exitCode !== 0) {
      throw new Error(`claude exec failed with exit code ${exitCode}. See ${stderrPath}`);
    }

    const parsed = parseClaudeJson(stdout);
    if (parsed.is_error) {
      throw new Error(`claude returned an error (${parsed.subtype ?? "unknown"}). See ${stdoutPath}`);
    }
    if (typeof parsed.result !== "string" || parsed.result.trim() === "") {
      throw new Error(`claude returned an empty result. See ${stdoutPath}`);
    }

    return { result: parsed.result, sessionId: parsed.session_id ?? input.sessionId ?? "", raw: stdout };
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeFile(path.join(input.jobDir, `claude-${input.logLabel}-error.log`), `${message}\n`, "utf8");
    throw error;
  }
}

type ClaudeJson = {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  session_id?: string;
};

function parseClaudeJson(stdout: string): ClaudeJson {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as ClaudeJson;
  } catch {
    // stream-json でない通常 json は1オブジェクト。想定外の出力に備えて最後の JSON 行を試す。
    const lastLine = trimmed.split(/\r?\n/).filter(Boolean).at(-1);
    if (lastLine) {
      return JSON.parse(lastLine) as ClaudeJson;
    }
    throw new Error("claude の JSON 出力をパースできませんでした");
  }
}

function spawnClaude(
  args: string[],
  prompt: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Windows では claude は claude.cmd 経由のため shell:true で起動する。
      // 引数は単純トークン(UUID/モデル名/フラグ)のみ。プロンプトは stdin から渡すので
      // shell によるクォート崩れの心配はない。
      child = spawn(config.CLAUDE_CLI_COMMAND, args, {
        shell: true,
        env: process.env,
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`claude exec timed out after ${config.CLAUDE_EXEC_TIMEOUT_MS}ms`));
    }, config.CLAUDE_EXEC_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      reject(error);
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      resolve({ exitCode, stdout, stderr });
    });

    child.stdin?.end(prompt, "utf8");
  });
}
