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
  CODEX_EXEC_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  // ⚠️ Do NOT set this. Verified 2026-06-23: setting ANTHROPIC_AUTH_TOKEN (or any
  // auth-override token) DISABLES the Claude in Chrome extension — `claude --chrome`
  // then silently falls back to Playwright, a separate browser with no logged-in
  // Google session, so NotebookLM redirects to the sign-in screen and sync fails.
  // The only `claude` CLI usage here is `--chrome` (NotebookLM); it requires the
  // subscription/keychain login (`/login`), which the token overrides and breaks.
  // (There are no headless text `claude -p` calls — runClaudeHeadless is unused —
  // so the token has no upside, only this breakage.) Kept optional only to warn below.
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
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
  // Phase4: Step3 で生成されたスライドデックの共有URLを claude --chrome で取得し
  // Firebase の manga.url へ登録する。Step3 が executed の時のみ動く後続フェーズ。
  // 既定 false(安全側)。前提は AUTOSYNC と同じ(Chrome + 拡張 + NotebookLM ログイン)。
  MANGA_DECK_AUTOFETCH: z.coerce.boolean().default(false),
  // Step3 トリガ後、生成完了を見込んで最初に待つ固定時間(約10分)。
  MANGA_DECK_INITIAL_WAIT_MS: z.coerce.number().int().positive().default(600_000),
  // 最初の確認でまだ生成中だった場合の追加待機(1回あたり、約1分)。
  MANGA_DECK_RETRY_WAIT_MS: z.coerce.number().int().positive().default(60_000),
  // 追加待機+再確認の最大回数。これを超えても未完了なら Slack へエラー通知する。
  MANGA_DECK_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  // URL取得エージェントが共有UIの探索を続けないよう、試行ごとのターン数を制限する。
  MANGA_DECK_FETCH_MAX_TURNS: z.coerce.number().int().positive().default(20),
  // 1回のデックURL取得(claude --chrome)の上限時間。
  MANGA_DECK_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),
  GOOGLE_SLIDES_TEMPLATE_ID: z.string().optional(),
  GAS_WEB_APP_URL: z.string().optional(),
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
  ),
  // ログイン必須サイト用のドメイン別Playwrightセッション(storageState)保存先。
  WEB_SESSIONS_DIR: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().default(join(homedir(), ".content-extractor", "sessions"))
  ),
  // 最初からセッション取得するドメインのカンマ区切りリスト(例: "nikkei.com,toyokeizai.net")。
  // 未指定でも、通常取得がペイウォール様かつセッションファイルが在るドメインは自動で再試行する。
  WEB_LOGIN_REQUIRED_DOMAINS: z.preprocess(
    (v) => (typeof v === "string" ? v : ""),
    z.string().default("")
  )
});

export const config = envSchema.parse(process.env);

if (config.ANTHROPIC_AUTH_TOKEN) {
  console.warn(
    "[config] ANTHROPIC_AUTH_TOKEN is set. This DISABLES the Claude in Chrome extension: `claude --chrome` " +
    "(NotebookLM sync / deck URL fetch) falls back to Playwright with no logged-in Google session, so it will " +
    "fail with a sign-in redirect. Remove ANTHROPIC_AUTH_TOKEN from .env and use the subscription login (`claude`, then /login)."
  );
}

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
