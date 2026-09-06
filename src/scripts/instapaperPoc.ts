import { readFile } from "node:fs/promises";
import { renderReadingEdition } from "../domains/reader/readingEdition.js";
import { InstapaperClient } from "../integrations/instapaper/instapaperClient.js";
import { loadDotEnv } from "../utils/envFile.js";
import { fail } from "./lib/cli.js";

loadDotEnv();

const mode = readArgument("--mode") || "url-content";
if (mode !== "url-content" && mode !== "private") {
  fail("--mode must be url-content or private");
}
const title = readArgument("--title") || "Instapaper → Kobo Phase 0 PoC";
const url =
  readArgument("--url") ||
  "https://lomoxiao.github.io/multimodal-article-viewer/?reader=instapaper-kobo-poc-v1";
const contentFile = readArgument("--content-file");
const content = contentFile ? await readFile(contentFile, "utf8") : defaultPocHtml(title);
const dryRun = process.argv.includes("--dry-run");

if (dryRun) {
  console.log(`Instapaper PoC dry run: mode=${mode}, title=${title}, contentBytes=${Buffer.byteLength(content, "utf8")}`);
  console.log(mode === "url-content" ? `URL: ${url}` : "URL: (private source)");
  process.exit(0);
}

const credentials = {
  consumerKey: process.env.INSTAPAPER_CONSUMER_KEY || "",
  consumerSecret: process.env.INSTAPAPER_CONSUMER_SECRET || "",
  accessToken: process.env.INSTAPAPER_ACCESS_TOKEN || "",
  accessTokenSecret: process.env.INSTAPAPER_ACCESS_TOKEN_SECRET || ""
};
const missing = Object.entries(credentials)
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length) fail(`Missing Instapaper credentials: ${missing.join(", ")}`);

const client = new InstapaperClient(credentials);
const bookmark = await client.addBookmark(
  mode === "private"
    ? { title, content, privateSource: "multimodal-article-viewer" }
    : { url, title, content }
);
console.log(`Instapaper PoC submitted: mode=${mode}, bookmarkId=${bookmark.bookmark_id}, title=${title}`);
if (mode === "url-content") console.log(`URL: ${url}`);
console.log("Koboで同期し、Homeの先頭にこの記事が表示されるか確認してください。");

function readArgument(name: string): string {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function defaultPocHtml(documentTitle: string): string {
  return renderReadingEdition({
    title: documentTitle,
    tldr: [
      "- 公開ページを作らず、Instapaperへ本文を直接送信します。",
      "- 日本語の見出し、段落、箇条書きがKoboで読めるか確認します。",
      "- 成功後、スライド生成パイプラインへ同じ経路を接続します。"
    ].join("\n"),
    markdown: [
      "# 表示確認",
      "",
      "この段落が自然な行間で表示され、文字サイズ変更とページ送りができれば本文表示は成功です。",
      "",
      "英数字も確認します: Personal AI OS / multimodal-article-viewer / Phase 0."
    ].join("\n"),
    sourceUrl: url
  });
}
