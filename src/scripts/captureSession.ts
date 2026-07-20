import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { normalizeDomain, resolveSessionPath } from "@local/content-extractor";
import { config } from "../config.js";
import { recordSessionCaptured } from "../shared/sessionStatusStore.js";

// ログイン必須サイトのセッション(storageState)を手動ログインで取得する。
// Usage: npm run session:capture -- <domain または URL>
// 注意: 保存されるJSONはCookie実体を含む。リポジトリへコミットしないこと。
const arg = process.argv[2];
if (!arg) {
  throw new Error("Usage: npm run session:capture -- <domain>  (例: npm run session:capture -- nikkei.com)");
}

const domain = normalizeDomain(arg.includes("://") ? arg : `https://${arg}`);
if (!domain) {
  throw new Error(`ドメインを解釈できません: ${arg}`);
}

const sessionPath = resolveSessionPath(domain, {
  playwrightSessions: { dir: config.web.sessionsDir }
});

console.log(`対象ドメイン: ${domain}`);
console.log(`保存先: ${sessionPath}`);
console.log("ブラウザが開きます。対象サイトへ手動でログインしてください。");

const browser = await chromium.launch({ channel: "chrome", headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`https://${domain}/`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => {
  console.warn(`トップページを開けませんでした(手動でURLを入力してください): ${error.message}`);
});

const readline = createInterface({ input: process.stdin, output: process.stdout });
await readline.question("ログインが完了したら Enter を押してください... ");
readline.close();

mkdirSync(dirname(sessionPath), { recursive: true });
await context.storageState({ path: sessionPath });
await browser.close();

await recordSessionCaptured(domain).catch(() => {});

console.log(`セッションを保存しました: ${sessionPath}`);
console.log("失効した場合は同じコマンドで再取得できます。");
