import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { config } from "../config.js";
import { NBLM_SESSION_DOMAIN } from "../domains/notebooklm/notebookLmPipeline.js";
import { notebookUrl } from "../domains/notebooklm/notebookLmDriver.js";
import { recordSessionCaptured } from "../shared/sessionStatusStore.js";

// NotebookLM 自動操作用の専用 Chrome プロファイルに手動で Google ログインする。
// Usage: npm run notebooklm:login
// ログイン状態はプロファイルディレクトリ(NOTEBOOKLM_PROFILE_DIR)に永続化される。
// 失効した場合も同じコマンドで再ログインできる。

console.log(`プロファイル: ${config.notebookLm.profileDir}`);
console.log("ブラウザが開きます。Google アカウントにログインし、NotebookLM が表示されることを確認してください。");

const context = await chromium.launchPersistentContext(config.notebookLm.profileDir, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"]
});

const page = context.pages()[0] ?? (await context.newPage());
const target = config.notebookLm.notebookId
  ? notebookUrl(config.notebookLm.notebookId)
  : "https://notebooklm.google.com/";
await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => {
  console.warn(`ページを開けませんでした(手動でURLを入力してください): ${error.message}`);
});

const readline = createInterface({ input: process.stdin, output: process.stdout });
await readline.question("ログインが完了し、ノートブックが表示されたら Enter を押してください... ");
readline.close();

await context.close();
await recordSessionCaptured(NBLM_SESSION_DOMAIN).catch(() => {});

console.log("プロファイルにログイン状態を保存しました。");
console.log("次の確認: npm run notebooklm:probe");
process.exit(0);
