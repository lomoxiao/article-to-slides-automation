import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// .env の読み込み共通実装(config.ts と firebaseAdmin.ts で共用)。
// ローカル .env を優先し、共有抽出器の資格情報(YOUTUBE_API_KEY 等)は
// リポジトリ非依存の中立 .env をフォールバックとして読む(既存値は上書きしない)。
export function loadDotEnv() {
  applyEnvFile(".env");
  applyEnvFile(join(homedir(), ".content-extractor", ".env"));
}

export function applyEnvFile(envPath: string) {
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
