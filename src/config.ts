import { existsSync, readFileSync } from "node:fs";
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
  CODEX_EXEC_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  CODEX_EXEC_FULL_AUTO: z.coerce.boolean().default(true),
  CODEX_EXEC_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  SUMMARY_PROVIDER: z.enum(["codex_job", "manual", "api"]).default("codex_job"),
  GOOGLE_AUTH_MODE: z.enum(["oauth", "service_account"]).default("oauth"),
  GOOGLE_OAUTH_CREDENTIALS: z.string().default("./google-oauth-credentials.json"),
  GOOGLE_OAUTH_TOKEN: z.string().default("./google-oauth-token.json"),
  GOOGLE_DRIVE_FOLDER_ID: z.string().optional(),
  GOOGLE_SLIDES_TEMPLATE_ID: z.string().optional(),
  GAS_WEB_APP_URL: z.string().optional(),
  TAVILY_API_KEY: z.string().optional()
});

export const config = envSchema.parse(process.env);

function loadDotEnv() {
  try {
    const envPath = ".env";

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
