import { getDb } from "../shared/firebaseAdmin.js";
import { createArticleIdentity } from "../shared/identity.js";
import { sanitizeArticleUrl } from "../utils/url.js";
import { usage } from "./lib/cli.js";

// Viewer に記事が出ない・状態がおかしいときの調査用。記事ノードの中身を表示する(読み取りのみ)。
// Usage: npm run article:show -- <記事URL または 記事ID(url_... / yt_... / txt_... / bnd_...)>
const arg = process.argv[2];
if (!arg) {
  usage("Usage: npm run article:show -- <記事URL または 記事ID>");
}

const articleId = /^(url|yt|txt|bnd)_[0-9a-f]+$/.test(arg) ? arg : createArticleIdentity(sanitizeArticleUrl(arg)).articleId;
const db = getDb();
const [article, source, audioIndex] = await Promise.all([
  db.ref(`/articles/${articleId}`).get(),
  db.ref(`/articleSources/${articleId}`).get(),
  db.ref(`/articleAudioIndex/${articleId}`).get()
]);

const sourceValue = source.val() as { markdown?: string; extractedAt?: string; quality?: unknown; title?: string } | null;
console.log(
  JSON.stringify(
    {
      articleId,
      exists: article.exists(),
      // Viewer は deletedAt がある記事を一覧に出さない
      hiddenInViewer: Boolean((article.val() as { deletedAt?: string } | null)?.deletedAt),
      article: article.val(),
      source: sourceValue
        ? {
            chars: sourceValue.markdown?.length ?? 0,
            extractedAt: sourceValue.extractedAt,
            quality: sourceValue.quality,
            title: sourceValue.title
          }
        : null,
      audio: audioIndex.val()
    },
    null,
    2
  )
);
// firebase-admin が接続を保持するため明示終了する
process.exit(0);
