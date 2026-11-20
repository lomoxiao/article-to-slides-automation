import test from "node:test";
import assert from "node:assert/strict";
import { buildClaudeToolArgs } from "../../shared/claudeRunner.js";
import { buildCodexExecArgs, createResearchPrompt } from "../../shared/codexRunner.js";
import { buildSpikePrompt, parseSpikeOutput, renderSpikeMarkdown, summarizeSpike, type SpikeRunResult } from "./researchSpike.js";

test("調査の Codex 実行: read-only で、Web 検索の方式を設定で渡す", () => {
  const args = buildCodexExecArgs({ sandbox: "read-only", configOverrides: ['web_search="cached"'] }, "last.txt");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("-c") + 1], 'web_search="cached"');
  // 既定(生成用)の実行は今までどおり -c を付けない
  assert.equal(buildCodexExecArgs({}, "last.txt").includes("-c"), false);
  assert.match(createResearchPrompt("x"), /untrusted input data/);
});

test("調査の Claude 実行: WebSearch / WebFetch だけを許可し、ファイル操作・コマンドは禁止のまま", () => {
  const args = buildClaudeToolArgs(["WebSearch", "WebFetch"]);
  assert.deepEqual(args.slice(0, 2), ["--allowedTools", "WebSearch,WebFetch"]);
  const disallowed = args.slice(args.indexOf("--disallowedTools") + 1);
  for (const tool of ["Bash", "Edit", "Write", "Read", "PowerShell"]) assert.ok(disallowed.includes(tool), tool);
  assert.ok(!disallowed.includes("WebSearch") && !disallowed.includes("WebFetch"));
  // 未指定なら今までどおり何も許可しない
  const none = buildClaudeToolArgs();
  assert.equal(none.includes("--allowedTools"), false);
  assert.ok(none.includes("WebSearch"));
  // 想定外のツール名は許可しない
  assert.equal(buildClaudeToolArgs(["Bash" as never]).includes("--allowedTools"), false);
});

test("出力の読み取りと集計", () => {
  const raw = `説明\n{"findings":[{"claim":"A","sourceTitle":"t","sourceUrl":"https://a.example/1"},{"claim":"B","sourceUrl":"https://b.example/2"}]}`;
  assert.equal(parseSpikeOutput(raw).length, 2);
  assert.throws(() => parseSpikeOutput("no json"));
  assert.match(buildSpikePrompt("問い"), /推測で作らない/);
  const results: SpikeRunResult[] = [
    { candidate: "codex-cached", question: 1, ok: true, durationMs: 60000, findings: 6, urls: 4, reachable: 3, unreachable: [{ url: "https://x", reason: "404" }] },
    { candidate: "codex-cached", question: 2, ok: false, error: "timeout", durationMs: 120000, findings: 0, urls: 0, reachable: 0, unreachable: [] }
  ];
  assert.deepEqual(summarizeSpike(results)[0], {
    candidate: "codex-cached", runs: 2, failures: 1, findings: 6, urls: 4, reachable: 3, reachableRate: "75%", avgSeconds: 90
  });
  const md = renderSpikeMarkdown(results, "2026-11-21T00:00:00Z", ["q1", "q2"]);
  assert.match(md, /\| codex-cached \| 2 \| 1 \| 6 \| 4 \| 3 \| 75% \| 90 \|/);
  assert.match(md, /https:\/\/x（404）/);
});
