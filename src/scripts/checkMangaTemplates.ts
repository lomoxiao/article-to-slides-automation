import { readdir } from "node:fs/promises";
import path from "node:path";

const mangaTemplatesDir = path.resolve("manga-templates");
const promptsDir = path.join(mangaTemplatesDir, "prompts");
const artStylesDir = path.join(mangaTemplatesDir, "art-styles");
const characterSheetsDir = path.join(mangaTemplatesDir, "character-sheets");
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => !name.startsWith(".") && name !== "README.md");
  } catch {
    return [];
  }
}

const prompts = await listFiles(promptsDir);
const artStyles = await listFiles(artStylesDir);
const characterSheets = (await listFiles(characterSheetsDir)).filter((name) =>
  IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())
);

const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

const step1 = prompts.find((name) => name.startsWith("01"));
const step2 = prompts.find((name) => name.startsWith("02"));
const step3 = prompts.find((name) => name.startsWith("03"));
checks.push({ label: "Step1 prompt (prompts/01_*)", ok: Boolean(step1), detail: step1 ?? "未配置(必須)" });
checks.push({ label: "Step2 prompt (prompts/02_*)", ok: Boolean(step2), detail: step2 ?? "未配置(必須)" });
checks.push({ label: "Step3 prompt (prompts/03_*)", ok: true, detail: step3 ?? "未配置(任意)" });

for (const style of ["A", "B", "C", "D", "E", "F", "G"]) {
  const match = artStyles.find((name) => name.startsWith(`画風${style}`) && name.toLowerCase().endsWith(".txt"));
  checks.push({ label: `画風${style} (art-styles/画風${style}*.txt)`, ok: Boolean(match), detail: match ?? "未配置" });
}

const required = checks.filter((c) => c.label.includes("Step1") || c.label.includes("Step2"));
const allRequiredOk = required.every((c) => c.ok);
const anyArtStyle = checks.some((c) => c.label.startsWith("画風") && c.ok);

console.log("manga-templates 配置チェック\n");
for (const c of checks) {
  console.log(`  ${c.ok ? "OK  " : "MISS"}  ${c.label.padEnd(34)} : ${c.detail}`);
}
console.log(
  `  INFO  ${"キャラクターシート画像 (任意)".padEnd(34)} : ${
    characterSheets.length > 0 ? `${characterSheets.length}件` : "未配置"
  }`
);
const unlabeledSheets = characterSheets.filter((name) => !name.includes("キャラクター"));
if (unlabeledSheets.length > 0) {
  console.log(`        注意: ファイル名に「キャラクター」を含まない画像: ${unlabeledSheets.join(", ")}`);
}
console.log("");

if (allRequiredOk && anyArtStyle) {
  console.log("=> 生成に必要な最小構成は揃っています（Step1/Step2 + 画風1つ以上）。");
} else {
  const reasons: string[] = [];
  if (!allRequiredOk) reasons.push("Step1/Step2 プロンプト");
  if (!anyArtStyle) reasons.push("画風ファイル(1つ以上)");
  console.log(`=> 不足: ${reasons.join(" / ")}。manga-templates/README.md の配置マニフェストを参照してください。`);
  process.exit(1);
}
