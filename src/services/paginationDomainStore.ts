import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ドメイン別に「実際に次ページ取得へ繋がったパターンid」を優先順で覚える。
// リポジトリ外(~/.content-extractor)に置き、move-to-front で並べ替える。
const STORE_PATH = join(homedir(), ".content-extractor", "pagination-domains.json");

export function loadPaginationDomainRules(): Record<string, string[]> {
  try {
    if (!existsSync(STORE_PATH)) return {};
    const parsed: unknown = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const rules: Record<string, string[]> = {};
    for (const [domain, patternIds] of Object.entries(parsed)) {
      if (Array.isArray(patternIds) && patternIds.every((id) => typeof id === "string")) {
        rules[domain] = patternIds;
      }
    }
    return rules;
  } catch {
    return {};
  }
}

export function recordPaginationSuccess(domain: string, patternId: string): void {
  if (!domain || !patternId) return;
  try {
    const rules = loadPaginationDomainRules();
    rules[domain] = [patternId, ...(rules[domain] ?? []).filter((id) => id !== patternId)];
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    // 並行実行時の部分書き込みを避けるため tmp + rename で保存する
    const tmpPath = `${STORE_PATH}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
    renameSync(tmpPath, STORE_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`pagination domain store update failed: ${message}`);
  }
}
