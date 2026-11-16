import { restoreDeletedArticle } from "../shared/firebaseArticleStore.js";
import { isSyntheticArticleUrl } from "../shared/identity.js";
import { sanitizeArticleUrl } from "../utils/url.js";
import { usage } from "./lib/cli.js";

// Viewer で削除した記事を一覧に戻す(削除済みの印を外すだけ。成果物や本文は変えない)。
// Usage: npm run article:restore -- <記事URL>
const url = process.argv[2];
if (!url) {
  usage("Usage: npm run article:restore -- <記事URL>");
}

const restored = await restoreDeletedArticle(isSyntheticArticleUrl(url) ? url : sanitizeArticleUrl(url));
console.log(restored ? "一覧に戻しました" : "削除済みの印は付いていませんでした(変更なし)");
// firebase-admin が接続を保持するため明示終了する
process.exit(0);
