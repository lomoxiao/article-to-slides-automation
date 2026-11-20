import { z } from "zod";

/**
 * 段階7(深掘りリサーチ)の事前確認。
 * Web 検索が使える実行方法の候補で同じ問いを調べ、返ってきた出典 URL が実在するか(取得できるか)を比べる。
 * ここは出力の検証と集計だけ。AI の実行と URL の取得は scripts/researchSpike.ts が行う。
 */
export const spikeFindingSchema = z.object({
  claim: z.string().trim().min(1).max(400),
  sourceTitle: z.string().trim().max(300).optional().default(""),
  sourceUrl: z.string().trim().min(1).max(2048)
});

export const spikeOutputSchema = z.object({ findings: z.array(spikeFindingSchema).max(30) });

export type SpikeFinding = z.infer<typeof spikeFindingSchema>;

export function buildSpikePrompt(question: string): string {
  return `次の問いについて Web を調べ、分かったことを出典つきで挙げてください。

問い: ${question}

出力は次の形の JSON だけにしてください(前後に説明文やコードブロック記号を書かない):
{"findings": [{"claim": "…", "sourceTitle": "…", "sourceUrl": "https://…"}]}

規則:
- findings は 5〜10 件。claim は日本語で 150 字以内。
- sourceUrl は、実際に検索結果に出てきた、または開いたページの URL だけ。推測で作らない。
- 1 つの claim に 1 つの出典。同じ出典を何度使ってもよい。`;
}

export function parseSpikeOutput(raw: string): SpikeFinding[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("output does not contain a JSON object");
  return spikeOutputSchema.parse(JSON.parse(raw.slice(start, end + 1))).findings;
}

export type SpikeRunResult = {
  candidate: string;
  question: number;
  ok: boolean;
  error?: string;
  durationMs: number;
  findings: number;
  urls: number;
  reachable: number;
  unreachable: Array<{ url: string; reason: string }>;
};

/** 候補ごとの合計。 */
export function summarizeSpike(results: SpikeRunResult[]): Array<{
  candidate: string;
  runs: number;
  failures: number;
  findings: number;
  urls: number;
  reachable: number;
  reachableRate: string;
  avgSeconds: number;
}> {
  const byCandidate = new Map<string, SpikeRunResult[]>();
  for (const result of results) byCandidate.set(result.candidate, [...(byCandidate.get(result.candidate) ?? []), result]);
  return [...byCandidate.entries()].map(([candidate, runs]) => {
    const urls = runs.reduce((sum, run) => sum + run.urls, 0);
    const reachable = runs.reduce((sum, run) => sum + run.reachable, 0);
    return {
      candidate,
      runs: runs.length,
      failures: runs.filter((run) => !run.ok).length,
      findings: runs.reduce((sum, run) => sum + run.findings, 0),
      urls,
      reachable,
      reachableRate: urls ? `${Math.round((reachable / urls) * 100)}%` : "-",
      avgSeconds: Math.round(runs.reduce((sum, run) => sum + run.durationMs, 0) / runs.length / 1000)
    };
  });
}

export function renderSpikeMarkdown(results: SpikeRunResult[], startedAt: string, questions: string[]): string {
  const summary = summarizeSpike(results);
  const lines = [
    "# 深掘りリサーチの事前確認の結果",
    "",
    `実行: ${startedAt}`,
    "",
    "## 候補ごとの合計",
    "",
    "| 候補 | 実行 | 失敗 | 挙げた事実 | 出典 URL(重複除く) | 取得できた | 取得できた割合 | 平均秒 |",
    "|---|---|---|---|---|---|---|---|",
    ...summary.map(
      (row) =>
        `| ${row.candidate} | ${row.runs} | ${row.failures} | ${row.findings} | ${row.urls} | ${row.reachable} | ${row.reachableRate} | ${row.avgSeconds} |`
    ),
    "",
    "## 問い",
    "",
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    "",
    "## 実行ごと",
    "",
    "| 候補 | 問い | 結果 | 秒 | 事実 | URL | 取得できた |",
    "|---|---|---|---|---|---|---|",
    ...results.map(
      (run) =>
        `| ${run.candidate} | ${run.question} | ${run.ok ? "成功" : `失敗: ${(run.error ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 120)}`} | ${Math.round(run.durationMs / 1000)} | ${run.findings} | ${run.urls} | ${run.reachable} |`
    ),
    "",
    "## 取得できなかった出典",
    "",
    ...results.flatMap((run) =>
      run.unreachable.map((item) => `- ${run.candidate} / 問い${run.question}: ${item.url}（${item.reason.replace(/\s+/g, " ").slice(0, 120)}）`)
    ),
    ""
  ];
  return lines.join("\n");
}
