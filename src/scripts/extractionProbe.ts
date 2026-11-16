import { readFile } from "node:fs/promises";
import { extractContent, type ExtractorOptions } from "@local/content-extractor";
import { buildExtractorOptions } from "../shared/sourceAggregator.js";
import { sanitizeArticleUrl } from "../utils/url.js";
import { usage } from "./lib/cli.js";

// 取り込みの計測用: URL一覧を順に取得し、判定・文字数・理由・エラー種別を Markdown の表で出す。
// 生成処理(Codex実行・Firebase書き込み・Slack通知)は一切行わない。
//
// Usage: npm run extraction:probe -- <urls.txt> [--user-agent <UA>]
//   urls.txt は1行1URL。空行と # で始まる行は無視する。
//   --user-agent を付けると、その名乗りで取得する(名乗りの違いによる差を測るため)。
const args = process.argv.slice(2);
const listPath = args.find((arg) => !arg.startsWith("--"));
if (!listPath) {
  usage("Usage: npm run extraction:probe -- <urls.txt> [--user-agent <UA>]");
}
const userAgentIndex = args.indexOf("--user-agent");
const userAgentOverride = userAgentIndex >= 0 ? args[userAgentIndex + 1] : undefined;
if (userAgentIndex >= 0 && !userAgentOverride) {
  usage("--user-agent には値を指定してください");
}

const base = buildExtractorOptions();
const options: ExtractorOptions = userAgentOverride
  ? { ...base, http: { ...base.http, userAgent: userAgentOverride } }
  : base;

const urls = (await readFile(listPath, "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map(sanitizeArticleUrl);

type Row = { url: string; verdict: string; chars: string; reasons: string; error: string; ms: number };
const rows: Row[] = [];

for (const url of urls) {
  const started = Date.now();
  try {
    const content = await extractContent({ url }, options);
    const quality = content.metadata.quality;
    rows.push({
      url,
      verdict: quality?.verdict ?? "(判定なし)",
      chars: String(quality?.chars ?? content.markdown.trim().length),
      reasons: quality?.reasons.join(", ") ?? "",
      error: "",
      ms: Date.now() - started
    });
  } catch (error) {
    const typed = error as Error & { code?: string; status?: number };
    rows.push({
      url,
      verdict: "failed",
      chars: "-",
      reasons: "",
      error: [typed.name, typed.code, typed.status].filter((value) => value !== undefined && value !== "").join(" / "),
      ms: Date.now() - started
    });
  }
}

const cell = (value: string) => value.replace(/\|/g, "\\|");
console.log(`名乗り: ${options.http?.userAgent ?? "(content-extractor 既定)"}`);
console.log(`実行日時: ${new Date().toISOString()}`);
console.log("");
console.log("| URL | 判定 | 文字数 | 理由 | エラー | 所要(ms) |");
console.log("|---|---|---|---|---|---|");
for (const row of rows) {
  console.log(`| ${cell(row.url)} | ${row.verdict} | ${row.chars} | ${cell(row.reasons)} | ${cell(row.error)} | ${row.ms} |`);
}

const counts = rows.reduce<Record<string, number>>((acc, row) => {
  acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
  return acc;
}, {});
console.log("");
console.log(`集計: ${Object.entries(counts).map(([verdict, count]) => `${verdict}=${count}`).join(", ")}`);
// Playwright 等がハンドルを保持する場合に備えて明示終了する
process.exit(0);
