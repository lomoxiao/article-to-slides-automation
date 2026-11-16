import { config } from "../config.js";
import { runDailyDigest, todayJst } from "../domains/digest/dailyDigestRunner.js";
import { fail, usage } from "./lib/cli.js";

// 「今日のまとめ」を手動で作る。失敗した日の再実行にも使う。
// Usage: npm run digest:run -- [--date YYYY-MM-DD] [--force]
//   --date  省略時は今日(JST)
//   --force 作成済み・失敗済みの印を無視して作り直す
const USAGE = "Usage: npm run digest:run -- [--date YYYY-MM-DD] [--force]";
const args = process.argv.slice(2);
const unknown = args.filter((arg, index) => arg.startsWith("--") ? !["--date", "--force"].includes(arg) : args[index - 1] !== "--date");
if (unknown.length > 0) usage(USAGE);

const dateIndex = args.indexOf("--date");
const date = dateIndex >= 0 ? args[dateIndex + 1] : todayJst(new Date());
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) usage(USAGE);
if (!config.digest.sourceDir) fail("DIGEST_SOURCE_DIR が未設定です(.env に news-dashboard の .runtime/digest の場所を書いてください)");

const result = await runDailyDigest(date, { force: args.includes("--force") });
console.log(JSON.stringify(result, null, 2));
// firebase-admin が接続を保持するため明示終了する
process.exit(result.status === "failed" ? 1 : 0);
