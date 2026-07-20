import { mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import {
  NBLM_SELECTORS,
  NBLM_SOURCE_NAMES,
  openNotebookLmSession
} from "../domains/notebooklm/notebookLmDriver.js";

// NotebookLM 決定論ドライバの診断ツール(読み取り専用。同期・チャット送信は行わない)。
// Usage: npm run notebooklm:probe
// - ログイン状態(signed_in/signed_out)の確認
// - 本番と同じセレクタ群の照合結果表示(UI変更時の修理箇所の特定)
// - Studio artifact 一覧の取得確認

if (!config.notebookLm.notebookId) {
  console.error(
    "NOTEBOOKLM_NOTEBOOK_ID が未設定です。.env にノートブック URL の /notebook/<UUID> 部分を設定してください。"
  );
  process.exit(1);
}

const probeDir = path.join("jobs", "manga", ".probe");
await mkdir(probeDir, { recursive: true });

console.log(`プロファイル: ${config.notebookLm.profileDir}`);
console.log(`ノートブック: ${config.notebookLm.notebookId}`);
console.log("接続しています...");

const opened = await openNotebookLmSession({
  notebookId: config.notebookLm.notebookId,
  jobDir: probeDir,
  logger: (m) => console.log(`  ${m}`)
});

if (!opened.ok) {
  console.error(`NG: 接続失敗 [${opened.failure.kind}] ${opened.failure.detail}`);
  if (opened.failure.screenshotPath) console.error(`  スクリーンショット: ${opened.failure.screenshotPath}`);
  if (opened.failure.kind === "signed_out") {
    console.error("  → npm run notebooklm:login でログインしてください");
  }
  process.exit(1);
}

const session = opened.value;
const page = session.page;
let hasMismatch = false;

console.log("OK: signed_in (ノートブック画面を確認)");

// セレクタ照合(読み取りのみ)
for (const [label, candidates] of [
  ["signedInIndicators", NBLM_SELECTORS.signedInIndicators],
  ["chatInput", NBLM_SELECTORS.chatInput],
  ["chatSubmit", NBLM_SELECTORS.chatSubmit]
] as const) {
  const matched: string[] = [];
  for (const selector of candidates) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) matched.push(selector);
  }
  const ok = matched.length > 0;
  // chatSubmit は Enter 送信フォールバックがあるため警告扱いにとどめる。
  if (!ok && label !== "chatSubmit") hasMismatch = true;
  console.log(`${ok ? "OK" : label === "chatSubmit" ? "WARN(Enter送信で代替)" : "NG"}: ${label} → ${matched.join(", ") || "一致なし"}`);
}

// ソース行の存在確認(クリックはしない)。ソースパネルはチャット欄より遅れて描画されるため、
// 本番の syncSources(click は自動待機する)と同様に、出現を最大15秒待ってから判定する。
for (const name of NBLM_SOURCE_NAMES) {
  const appeared = await page
    .getByText(name, { exact: true })
    .first()
    .waitFor({ state: "attached", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const count = appeared ? await page.getByText(name, { exact: true }).count().catch(() => 0) : 0;
  if (!appeared) hasMismatch = true;
  console.log(`${appeared ? "OK" : "NG"}: ソース「${name}」 → ${count} 件`);
}

// Studio artifact 一覧
const snapshot = await session.snapshotArtifacts();
if (snapshot.ok) {
  console.log(`OK: Studio artifact 一覧 → ${snapshot.value.items.length} 件 (studioFound=${snapshot.value.studioFound})`);
  for (const item of snapshot.value.items.slice(0, 5)) {
    console.log(`  - ${item.id ?? "(ID不明)"}: ${item.text.slice(0, 60)}`);
  }
} else {
  hasMismatch = true;
  console.log(`NG: Studio artifact 一覧 → [${snapshot.failure.kind}] ${snapshot.failure.detail}`);
}

await session.close();

if (hasMismatch) {
  console.log("\n結果: NG あり。notebookLmDriver.ts の NBLM_SELECTORS を実DOMに合わせて修正してください。");
  process.exit(1);
}
console.log("\n結果: すべて green。決定論ドライバは動作可能です。");
process.exit(0);
