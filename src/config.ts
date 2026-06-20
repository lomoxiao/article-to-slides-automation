import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

loadDotEnv();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_COMPLETION_CHANNEL_ID: z.string().optional(),
  AUTO_RUN_CODEX: z.coerce.boolean().default(true),
  CODEX_CLI_COMMAND: z.string()
    .default("codex")
    .refine(
      (value) => !value.toLowerCase().includes("\\windowsapps\\"),
      {
        message:
          "CODEX_CLI_COMMAND must not point to a WindowsApps path. " +
          "Set the full path to the user-installed codex.exe " +
          "(e.g. C:\\Users\\<name>\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe)."
      }
    ),
  CODEX_RUNNER_HOME: z.string().default("./.codex-runner-home"),
  CODEX_SOURCE_HOME: z.string().optional(),
  CODEX_MODEL: z.string().default("gpt-5.5"),
  CODEX_EXEC_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  CODEX_EXEC_FULL_AUTO: z.coerce.boolean().default(true),
  CODEX_EXEC_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  // Claude Code settings are only used by NotebookLM autosync (`claude --chrome`).
  // Manga Step1/Step2 generation uses the CODEX_* settings above.
  CLAUDE_CLI_COMMAND: z.string().default("claude"),
  CLAUDE_MODEL: z.string().default("opus"),
  CLAUDE_EXEC_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  SUMMARY_PROVIDER: z.enum(["codex_job", "manual", "api"]).default("codex_job"),
  GOOGLE_AUTH_MODE: z.enum(["oauth", "service_account"]).default("oauth"),
  GOOGLE_OAUTH_CREDENTIALS: z.string().default("./google-oauth-credentials.json"),
  GOOGLE_OAUTH_TOKEN: z.string().default("./google-oauth-token.json"),
  GOOGLE_DRIVE_FOLDER_ID: z.string().optional(),
  // manga アウトライン(step1/step2)の Drive アップロード先フォルダ。
  // 未設定ならアップロードはスキップ。Google ドキュメントに変換して固定名で upsert する。
  MANGA_DRIVE_FOLDER_ID: z.string().optional(),
  // Phase3: NotebookLM 自動操作(claude --chrome)。Drive アップロード成功後に
  // 固定ノートブックの step1/step2 ソースを Drive 同期し、チャットで Step3 をトリガする。
  // 既定 false(安全側)。有効化するにはホストで Chrome 起動 + Claude in Chrome 拡張接続 +
  // NotebookLM ログイン維持が必要。
  MANGA_NOTEBOOKLM_AUTOSYNC: z.coerce.boolean().default(false),
  // 操作対象の固定ノートブック名。
  MANGA_NOTEBOOKLM_NAME: z.string().default("漫画Maker"),
  // チャット応答待ちを含むブラウザ操作の上限時間(生成 step1/step2 とは別枠)。
  MANGA_NOTEBOOKLM_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  GOOGLE_SLIDES_TEMPLATE_ID: z.string().optional(),
  GAS_WEB_APP_URL: z.string().optional(),
  MULTIMODAL_ARTICLES_JSON_PATH: z.string().default("../multimodal-article-viewer/articles.json"),
  TAVILY_API_KEY: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  // 空文字(.env に空で残った場合)は未設定とみなし、中立な既定パスを使う。
  X_SESSION_STATE_PATH: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().default(join(homedir(), ".content-extractor", "x-session.json"))
  ),
  X_HEADLESS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.boolean().default(true)
  )
});

export const config = envSchema.parse(process.env);

function loadDotEnv() {
  // ローカル .env を優先し、共有抽出器の資格情報(YOUTUBE_API_KEY 等)は
  // リポジトリ非依存の中立 .env をフォールバックとして読む(既存値は上書きしない)。
  applyEnvFile(".env");
  applyEnvFile(join(homedir(), ".content-extractor", ".env"));
}

function applyEnvFile(envPath: string) {
  try {
    if (!existsSync(envPath)) {
      return;
    }

    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();

      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Environment files are optional; deployment platforms can inject variables directly.
  }
}
