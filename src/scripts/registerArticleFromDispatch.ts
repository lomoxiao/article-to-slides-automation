import { registerArticle } from "../shared/firebaseArticleStore.js";
import { normalizeSaveOrigin } from "../shared/registeredFrom.js";
import { fail } from "./lib/cli.js";
import { sanitizeArticleUrl } from "../utils/url.js";

// Entry point for the GitHub Actions `repository_dispatch` workflow.
// The workflow maps client_payload.{url,title,headline,from} to these env vars.
const url = sanitizeArticleUrl(process.env.ARTICLE_URL ?? "");
const title = process.env.ARTICLE_TITLE || undefined;
const headline = process.env.ARTICLE_HEADLINE || undefined;
// 保存元(iPhone のショートカット / PC のブックマークレット)。知らない値は shortcut に丸める。
const registeredFrom = normalizeSaveOrigin(process.env.ARTICLE_FROM);

if (!url.trim()) {
  fail("ARTICLE_URL is required");
}

try {
  const result = await registerArticle({ url, title, headline, registeredFrom });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  // firebase-admin keeps an open Realtime Database connection that would keep
  // the process alive; exit explicitly once the write completes.
  process.exit(0);
} catch (error) {
  fail(`registerArticle failed: ${error instanceof Error ? error.message : String(error)}`);
}
