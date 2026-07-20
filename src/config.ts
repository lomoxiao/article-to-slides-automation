import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadDotEnv } from "./utils/envFile.js";

loadDotEnv();

// 環境変数スキーマは env 名そのまま(flat)で定義し、export はドメイン別にグループ化する。
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_COMPLETION_CHANNEL_ID: z.string().optional(),
  AUTO_RUN_CODEX: envBool(true),
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
  // 資格情報の正本はリポジトリ外の ~/.content-extractor/(gitignore 頼みで平文秘密を
  // リポジトリ内に置かない)。移行期のみ、そこに無ければ従来のリポジトリ直下へフォールバック。
  GOOGLE_OAUTH_CREDENTIALS: z.string().default(resolveCredentialPath("google-oauth-credentials.json")),
  GOOGLE_OAUTH_TOKEN: z.string().default(resolveCredentialPath("google-oauth-token.json")),
  GOOGLE_DRIVE_FOLDER_ID: z.string().optional(),
  // manga アウトライン(step1/step2)の Drive アップロード先フォルダ。
  // 未設定ならアップロードはスキップ。Google ドキュメントに変換して固定名で upsert する。
  MANGA_DRIVE_FOLDER_ID: z.string().optional(),
  // Phase3: NotebookLM 自動操作(claude --chrome)。Drive アップロード成功後に
  // 固定ノートブックの step1/step2 ソースを Drive 同期し、チャットで Step3 をトリガする。
  // 既定 false(安全側)。有効化するにはホストで Chrome 起動 + Claude in Chrome 拡張接続 +
  // NotebookLM ログイン維持が必要。
  MANGA_NOTEBOOKLM_AUTOSYNC: envBool(false),
  // 操作対象の固定ノートブック名。
  MANGA_NOTEBOOKLM_NAME: z.string().default("漫画Maker"),
  // チャット応答待ちを含むブラウザ操作の上限時間(生成 step1/step2 とは別枠)。
  MANGA_NOTEBOOKLM_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // Phase4: Step3 で生成されたスライドデックの共有URLを取得し Firebase の manga.url へ
  // 登録する。Step3 が executed の時のみ動く後続フェーズ。既定 false(安全側)。
  MANGA_DECK_AUTOFETCH: envBool(false),
  // --- NotebookLM 決定論 Playwright ドライバ(主経路) ---
  // 専用 Chrome プロファイル。`npm run notebooklm:login` で1回だけ手動ログインして永続化する。
  // ユーザー既定プロファイルは Chrome の制約で自動操作に使えないため必ず専用ディレクトリにする。
  NOTEBOOKLM_PROFILE_DIR: z.string().default(join(homedir(), ".notebooklm-profile")),
  // 操作対象ノートブックの UUID。未設定/抽出不能なら Playwright 経路は起動せず、従来の
  // claude --chrome 経路(名前 MANGA_NOTEBOOKLM_NAME で探索)のみで動く。
  // フルURL(https://notebooklm.google.com/notebook/<UUID>...)でも UUID だけでも受け付け、
  // 引用符・前後空白・末尾スラッシュを許容して UUID を抽出する(貼り付け方の揺れに強くする)。
  // UUID を取り出せない不正値でも config 全体を落とさない(下で警告する)。
  NOTEBOOKLM_NOTEBOOK_ID: z.preprocess((v) => extractNotebookId(v), z.string().optional()),
  // 既定 false(headed)。Google ログイン維持と挙動検証のしやすさを優先する。
  NOTEBOOKLM_HEADLESS: envBool(false, { emptyMeans: "default" }),
  // デック生成完了のポーリング間隔と総待機上限(Playwright 経路)。
  MANGA_DECK_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  MANGA_DECK_COMPLETE_TIMEOUT_MS: z.coerce.number().int().positive().default(2_400_000),
  // 「現在、回答できません」検出時の reload+再送 回数(バックオフ 2/4/8分)。
  MANGA_NBLM_CHAT_RETRIES: z.coerce.number().int().nonnegative().default(3),
  // セレクタ不一致(ui_mismatch)時に claude --chrome 経路へフォールバックする。
  // "false"・"0"・空文字のいずれでも無効化できる。
  MANGA_NBLM_FALLBACK_CLAUDE_CHROME: envBool(true),
  // --- 以下3つは claude --chrome フォールバック経路専用(旧 Phase4 の待機モデル) ---
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
  X_HEADLESS: envBool(true, { emptyMeans: "default" }),
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

const env = envSchema.parse(process.env);

// ドメイン別にグループ化した設定。env 変数名との対応は上のスキーマを参照。
export const config = {
  server: {
    port: env.PORT
  },
  slack: {
    appToken: env.SLACK_APP_TOKEN,
    botToken: env.SLACK_BOT_TOKEN,
    completionChannelId: env.SLACK_COMPLETION_CHANNEL_ID
  },
  codex: {
    autoRun: env.AUTO_RUN_CODEX,
    cliCommand: env.CODEX_CLI_COMMAND,
    runnerHome: env.CODEX_RUNNER_HOME,
    sourceHome: env.CODEX_SOURCE_HOME,
    model: env.CODEX_MODEL,
    execSandbox: env.CODEX_EXEC_SANDBOX,
    execTimeoutMs: env.CODEX_EXEC_TIMEOUT_MS
  },
  claude: {
    anthropicAuthToken: env.ANTHROPIC_AUTH_TOKEN,
    cliCommand: env.CLAUDE_CLI_COMMAND,
    model: env.CLAUDE_MODEL,
    execTimeoutMs: env.CLAUDE_EXEC_TIMEOUT_MS
  },
  summary: {
    provider: env.SUMMARY_PROVIDER
  },
  google: {
    authMode: env.GOOGLE_AUTH_MODE,
    oauthCredentials: env.GOOGLE_OAUTH_CREDENTIALS,
    oauthToken: env.GOOGLE_OAUTH_TOKEN,
    driveFolderId: env.GOOGLE_DRIVE_FOLDER_ID,
    slidesTemplateId: env.GOOGLE_SLIDES_TEMPLATE_ID,
    gasWebAppUrl: env.GAS_WEB_APP_URL
  },
  manga: {
    driveFolderId: env.MANGA_DRIVE_FOLDER_ID,
    notebookLmAutosync: env.MANGA_NOTEBOOKLM_AUTOSYNC,
    notebookLmName: env.MANGA_NOTEBOOKLM_NAME,
    notebookLmTimeoutMs: env.MANGA_NOTEBOOKLM_TIMEOUT_MS,
    deckAutofetch: env.MANGA_DECK_AUTOFETCH,
    deckPollIntervalMs: env.MANGA_DECK_POLL_INTERVAL_MS,
    deckCompleteTimeoutMs: env.MANGA_DECK_COMPLETE_TIMEOUT_MS,
    nblmChatRetries: env.MANGA_NBLM_CHAT_RETRIES,
    nblmFallbackClaudeChrome: env.MANGA_NBLM_FALLBACK_CLAUDE_CHROME,
    deckInitialWaitMs: env.MANGA_DECK_INITIAL_WAIT_MS,
    deckRetryWaitMs: env.MANGA_DECK_RETRY_WAIT_MS,
    deckMaxRetries: env.MANGA_DECK_MAX_RETRIES,
    deckFetchMaxTurns: env.MANGA_DECK_FETCH_MAX_TURNS,
    deckFetchTimeoutMs: env.MANGA_DECK_FETCH_TIMEOUT_MS
  },
  notebookLm: {
    profileDir: env.NOTEBOOKLM_PROFILE_DIR,
    notebookId: env.NOTEBOOKLM_NOTEBOOK_ID,
    headless: env.NOTEBOOKLM_HEADLESS
  },
  web: {
    tavilyApiKey: env.TAVILY_API_KEY,
    youtubeApiKey: env.YOUTUBE_API_KEY,
    xSessionStatePath: env.X_SESSION_STATE_PATH,
    xHeadless: env.X_HEADLESS,
    sessionsDir: env.WEB_SESSIONS_DIR,
    loginRequiredDomains: env.WEB_LOGIN_REQUIRED_DOMAINS
  }
} as const;

if (process.env.NOTEBOOKLM_NOTEBOOK_ID?.trim() && !env.NOTEBOOKLM_NOTEBOOK_ID) {
  console.warn(
    "[config] NOTEBOOKLM_NOTEBOOK_ID is set but no notebook UUID could be extracted from it. " +
      "The Playwright NotebookLM driver is DISABLED (falling back to claude --chrome). " +
      "Paste the notebook URL (https://notebooklm.google.com/notebook/<UUID>) or just the <UUID>."
  );
}

if (env.ANTHROPIC_AUTH_TOKEN) {
  console.warn(
    "[config] ANTHROPIC_AUTH_TOKEN is set. This DISABLES the Claude in Chrome extension: `claude --chrome` " +
    "(NotebookLM sync / deck URL fetch) falls back to Playwright with no logged-in Google session, so it will " +
    "fail with a sign-in redirect. Remove ANTHROPIC_AUTH_TOKEN from .env and use the subscription login (`claude`, then /login)."
  );
}

/**
 * 環境変数の boolean パース。z.coerce.boolean は Boolean(文字列) のため
 * "false" が true になる罠があり(旧実装)、明示的な語彙で解釈する。
 * - "1" / "true" / "yes" / "on"  → true
 * - "0" / "false" / "no" / "off" → false
 * - 空文字 → false(emptyMeans: "default" 指定時は既定値)
 * - 未設定 → 既定値 / 解釈不能な値 → 警告して既定値(config 全体は落とさない)
 */
function envBool(defaultValue: boolean, options: { emptyMeans?: "false" | "default" } = {}) {
  return z.preprocess((value) => {
    if (typeof value !== "string") {
      return defaultValue;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "") {
      return options.emptyMeans === "default" ? defaultValue : false;
    }
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
    console.warn(
      `[config] unrecognized boolean value ${JSON.stringify(value)}; using default (${defaultValue}).`
    );
    return defaultValue;
  }, z.boolean());
}

/**
 * NOTEBOOKLM_NOTEBOOK_ID 入力から UUID を取り出す。フルURL・UUID単体のどちらも許容し、
 * 引用符・前後空白・末尾スラッシュを除去する。UUID を取り出せない/空文字/未設定は
 * undefined を返す(Playwright 経路を無効化。config 全体は落とさず下で警告する)。
 */
function extractNotebookId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.trim().replace(/^['"]|['"]$/g, "").trim();
  if (cleaned === "") {
    return undefined;
  }
  const match = cleaned.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : undefined;
}

/**
 * 資格情報ファイルの既定パスを解決する(.env 等で明示設定されていれば zod の
 * default は使われないため、この関数は「未設定時」のみ効く)。
 * ~/.content-extractor/<name> を正とし、無ければ従来のリポジトリ直下 ./<name> が
 * 存在する場合に限りそちらへフォールバックして移行を促す警告を出す。
 */
function resolveCredentialPath(name: string): string {
  const canonical = join(homedir(), ".content-extractor", name);
  if (existsSync(canonical)) {
    return canonical;
  }
  const legacy = `./${name}`;
  if (existsSync(legacy)) {
    console.warn(
      `[config] ${name} was found in the repository root. Move it to ${canonical} ` +
        "(credentials should not live inside the repository, even gitignored)."
    );
    return legacy;
  }
  return canonical;
}
