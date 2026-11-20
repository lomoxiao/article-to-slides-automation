import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runClaudeHeadless } from "../shared/claudeRunner.js";
import { runCodexResearchPrompt } from "../shared/codexRunner.js";
import { fetchSourceContent } from "../shared/sourceAggregator.js";
import { buildSpikePrompt, parseSpikeOutput, renderSpikeMarkdown, type SpikeRunResult } from "../domains/research/researchSpike.js";

// 段階7(深掘りリサーチ)の事前確認。固定課金の Codex / Claude Code で Web 検索が使えるか、
// 返ってくる出典 URL が実在するかを、同じ問いで比べる。Firebase への書き込み・Slack 通知はしない。
//
// Usage: npm run research:spike -- [--only codex-cached,codex-live,claude] [--questions 1,2,3]
//   結果は docs/research-spike-results.md と jobs/research-spike/<日時>/ に出る。
//   3 候補 × 3 問で 20〜40 分ほどかかる見込み。常駐プロセスが生成中でないときに実行する。

const QUESTIONS = [
  "日本で発行が始まった円建てステーブルコイン（電子決済手段）について、最近の動きと、関係者や報道の評価",
  "量子コンピュータを金融の最適化（ポートフォリオ・資金繰りなど）に使った実証事例と、その後の動き",
  "耐量子計算機暗号（PQC）への移行について、決済・カード業界の動きと課題"
];

type Candidate = { id: string; run: (prompt: string, jobDir: string, label: string) => Promise<string> };

const CANDIDATES: Candidate[] = [
  {
    id: "codex-cached",
    run: async (prompt, jobDir, label) => (await runCodexResearchPrompt({ prompt, jobDir, logLabel: label, webSearch: "cached" })).result
  },
  {
    id: "codex-live",
    run: async (prompt, jobDir, label) => (await runCodexResearchPrompt({ prompt, jobDir, logLabel: label, webSearch: "live" })).result
  },
  {
    id: "claude",
    run: async (prompt, jobDir, label) =>
      (await runClaudeHeadless({ prompt, jobDir, logLabel: label, allowedTools: ["WebSearch", "WebFetch"] })).result
  }
];

function listArg(name: string): string[] | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean) : undefined;
}

const only = listArg("--only");
const questionNumbers = (listArg("--questions") ?? ["1", "2", "3"]).map(Number).filter((n) => n >= 1 && n <= QUESTIONS.length);
const candidates = CANDIDATES.filter((candidate) => !only || only.includes(candidate.id));
const startedAt = new Date().toISOString();
const runDir = path.join("jobs", "research-spike", startedAt.replace(/[:.]/g, "-"));
await mkdir(runDir, { recursive: true });

const results: SpikeRunResult[] = [];
for (const candidate of candidates) {
  for (const number of questionNumbers) {
    const label = `${candidate.id}-q${number}`;
    const started = Date.now();
    console.log(`[research-spike] ${label} ...`);
    const result: SpikeRunResult = { candidate: candidate.id, question: number, ok: false, durationMs: 0, findings: 0, urls: 0, reachable: 0, unreachable: [] };
    try {
      const raw = await candidate.run(buildSpikePrompt(QUESTIONS[number - 1]!), runDir, label);
      result.durationMs = Date.now() - started;
      const findings = parseSpikeOutput(raw);
      result.findings = findings.length;
      const urls = [...new Set(findings.map((finding) => finding.sourceUrl))];
      result.urls = urls.length;
      for (const url of urls) {
        try {
          await fetchSourceContent(url);
          result.reachable += 1;
        } catch (error) {
          result.unreachable.push({ url, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      result.ok = true;
      await writeFile(path.join(runDir, `${label}-findings.json`), `${JSON.stringify(findings, null, 2)}\n`, "utf8");
    } catch (error) {
      result.durationMs = result.durationMs || Date.now() - started;
      result.error = error instanceof Error ? error.message : String(error);
    }
    results.push(result);
    console.log(
      `[research-spike] ${label}: ${result.ok ? `ok findings=${result.findings} urls=${result.urls} reachable=${result.reachable}` : `failed: ${result.error}`} (${Math.round(result.durationMs / 1000)}s)`
    );
  }
}

const markdown = renderSpikeMarkdown(results, startedAt, QUESTIONS);
await writeFile(path.join(runDir, "results.md"), markdown, "utf8");
await writeFile(path.join("docs", "research-spike-results.md"), markdown, "utf8");
console.log(`[research-spike] done. See docs/research-spike-results.md (details: ${runDir})`);
process.exit(0);
