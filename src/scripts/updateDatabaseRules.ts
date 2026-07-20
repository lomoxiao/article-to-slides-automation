import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../shared/firebaseAdmin.js";

// ライブRulesにはリポジトリ外のキー(homeworkJobsV3等)があるため、
// テンプレートの丸ごとPUTは禁止。必ず「ライブ取得→パッチをマージ→PUT」で更新する。
const usage = "Usage: npx tsx src/scripts/updateDatabaseRules.ts <patch.json> [--apply]";

const patchPath = process.argv[2];
const apply = process.argv.includes("--apply");

if (!patchPath || !existsSync(patchPath)) {
  throw new Error(usage);
}

const patch = JSON.parse(readFileSync(patchPath, "utf8"));

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (
    typeof base !== "object" || base === null || Array.isArray(base) ||
    typeof overlay !== "object" || overlay === null || Array.isArray(overlay)
  ) {
    return overlay;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result;
}

function collectPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) => collectPaths(child, `${prefix}/${key}`));
}

const db = getDb();
const liveSource = await db.getRules();

let live: unknown;
try {
  live = JSON.parse(liveSource);
} catch {
  throw new Error("ライブRulesがJSONとして解釈できません(コメント入り?)。手動で確認してください。");
}

const backupDir = join(homedir(), ".content-extractor", "rules-backups");
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `rules-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(backupPath, liveSource, "utf8");

const merged = deepMerge(live, patch);

console.log(`backup: ${backupPath}`);
console.log("patch paths:");
for (const path of collectPaths(patch)) {
  console.log(`  ${path}`);
}

if (!apply) {
  console.log("\n--apply が指定されていないため PUT していません(dry-run)。マージ結果:");
  console.log(JSON.stringify(merged, null, 2));
  process.exit(0);
}

await db.setRules(JSON.stringify(merged, null, 2));
console.log("Rules を更新しました。");
process.exit(0);
