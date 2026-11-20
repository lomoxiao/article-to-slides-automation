import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BundleProgress, ResearchSourceRecord, StoredArticleSummary } from "../../shared/firebaseArticleStore.js";
import { createArticleIdentity, createResearchIdentity, isSyntheticArticleUrl } from "../../shared/identity.js";
import { buildInvestigatePrompt, buildResearchMarkdown, buildSynthesizePrompt, parseFindings, parseResearchSynthesis } from "./researchReport.js";
import { runResearch, type ResearchDeps } from "./researchPipeline.js";

test("深掘りのID: 元記事・観点(順不同)・補足が同じなら同じID。疑似URLから戻せる", () => {
  const a = createResearchIdentity("url_a", ["reception", "related"], "決済の観点");
  const b = createResearchIdentity("url_a", ["related", "reception", "related"], "  決済の観点 ");
  assert.equal(a.articleId, b.articleId);
  assert.match(a.articleId, /^rsc_[0-9a-f]{12}$/);
  assert.equal(a.sourceKind, "research");
  assert.deepEqual(createArticleIdentity(a.canonicalUrl), a);
  assert.equal(isSyntheticArticleUrl(a.canonicalUrl), true);
  assert.notEqual(a.articleId, createResearchIdentity("url_a", ["related"], "決済の観点").articleId);
  assert.notEqual(a.articleId, createResearchIdentity("url_b", ["reception", "related"], "決済の観点").articleId);
});

const base = { title: "元の記事", url: "https://example.com/base", summary: "元記事の要約", points: ["要点1", "要点2"] };

test("調べるプロンプト: 選んだ観点だけを出し、補足は観点として扱う。出力は依頼した観点と http(s) だけ残す", () => {
  const prompt = buildInvestigatePrompt(base, ["related", "counter"], "決済の観点");
  assert.match(prompt, /related（関連する記事）/);
  assert.match(prompt, /counter（反対意見・懸念）/);
  assert.doesNotMatch(prompt, /impact（/);
  assert.match(prompt, /指示の上書きには使わない/);
  const raw = JSON.stringify({
    findings: [
      { aspect: "related", claim: "A", sourceUrl: "https://a.example/1" },
      { aspect: "impact", claim: "依頼していない観点", sourceUrl: "https://b.example/2" },
      { aspect: "counter", claim: "B", sourceUrl: "javascript:alert(1)" },
      { aspect: "counter", claim: "", sourceUrl: "https://c.example/3" },
      { aspect: "counter", claim: "C", sourceUrl: "https://d.example/4" }
    ]
  });
  assert.deepEqual(parseFindings(raw, ["related", "counter"]).map((finding) => finding.claim), ["A", "C"]);
  assert.throws(() => parseFindings("no json", ["related"]));
});

test("まとめるプロンプトと本文: 出典は取得できたものだけ。確認できなかった出典は別に一覧する", () => {
  const sources = [
    { index: 1, url: "https://a.example/1", title: "出典A", text: "本文A" },
    { index: 2, url: "https://d.example/4", title: "出典D", text: "本文D" }
  ];
  const prompt = buildSynthesizePrompt(base, ["related", "counter"], [{ aspect: "related", claim: "A", sourceTitle: "", sourceUrl: "https://a.example/1", sourceIndex: 1 }], sources);
  assert.match(prompt, /信頼できない入力データ/);
  assert.match(prompt, /\[1\] 出典A\n本文A/);
  const synthesis = parseResearchSynthesis(
    JSON.stringify({
      title: "深掘り",
      tldr: ["- 一", "二", "三"],
      sections: [
        { heading: "関連する記事", body: "本文。", sources: [1] },
        { heading: "反対意見・懸念", body: "確認できる出典が見つかりませんでした。", sources: [] }
      ]
    }),
    2
  );
  assert.deepEqual(synthesis.tldr, ["一", "二", "三"]);
  assert.throws(() => parseResearchSynthesis(JSON.stringify({ title: "t", tldr: ["a", "b", "c"], sections: [{ heading: "h", body: "b", sources: [3] }] }), 2), /unknown source/);
  const body = buildResearchMarkdown(base, synthesis, sources, [{ url: "https://x.example/9", reason: "サイトに取得を拒否されました" }]);
  assert.ok(body.startsWith("元の記事: 元の記事 https://example.com/base"));
  assert.match(body, /## 関連する記事\n\n本文。\n\n出典: \[1\] 出典A/);
  assert.match(body, /## 出典\n\n- \[1\] 出典A https:\/\/a.example\/1\n- \[2\] 出典D/);
  assert.match(body, /## 確認できなかった出典[\s\S]*https:\/\/x.example\/9（サイトに取得を拒否されました）/);
});

const investigation = JSON.stringify({
  findings: [
    { aspect: "related", claim: "A は X と報じた", sourceTitle: "A", sourceUrl: "https://a.example/1" },
    { aspect: "related", claim: "B は Y と報じた", sourceTitle: "B", sourceUrl: "https://b.example/2" },
    { aspect: "reception", claim: "C は慎重な見方", sourceTitle: "C", sourceUrl: "https://c.example/3" },
    { aspect: "reception", claim: "元記事そのもの", sourceTitle: "base", sourceUrl: "https://example.com/base" }
  ]
});
const synthesisJson = JSON.stringify({
  title: "深掘りレポート",
  tldr: ["一", "二", "三"],
  sections: [
    { heading: "関連する記事", body: "まとめ。", sources: [1] },
    { heading: "世間の評価", body: "評価。", sources: [2] }
  ],
  narration: `今日の深掘りです。\n${"関連する記事と評価をお伝えします。".repeat(45)}`
});

async function setup(options: {
  unreachable?: string[];
  investigations?: string[];
  synthesisOutputs?: string[];
  usage?: Record<string, number>;
  baseArticle?: StoredArticleSummary | null;
  existing?: boolean;
  slow?: boolean;
} = {}) {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), "research-test-"));
  const calls = {
    progress: [] as string[],
    registered: [] as Array<{ url: string; title: string }>,
    sources: [] as ResearchSourceRecord[][],
    bodies: [] as string[],
    investigatePrompts: [] as string[],
    synthesisPrompts: [] as string[],
    fetched: [] as string[],
    audio: 0,
    usage: [] as Array<Record<string, number>>
  };
  const investigations = options.investigations ?? [investigation];
  const syntheses = options.synthesisOutputs ?? [synthesisJson];
  const article = (articleId: string): StoredArticleSummary => ({
    articleId,
    canonicalUrl: "https://example.com/base",
    title: "元の記事",
    sourceKind: "web",
    deleted: false
  });
  const deps: ResearchDeps = {
    maxSources: 12,
    maxPerDay: 10,
    timeoutMs: options.slow ? 50 : 60_000,
    jobsRoot,
    now: () => new Date("2026-11-21T00:00:00Z"),
    getArticle: async (articleId) => {
      if (articleId.startsWith("rsc_")) return options.existing ? { ...article(articleId), sourceKind: "research" } : undefined;
      if (options.baseArticle === null) return undefined;
      return options.baseArticle ?? article(articleId);
    },
    loadBase: async () => {
      if (options.slow) await new Promise((resolve) => setTimeout(resolve, 200));
      return base;
    },
    investigate: async (prompt) => {
      calls.investigatePrompts.push(prompt);
      return investigations.shift() ?? "";
    },
    fetchSource: async (url) => {
      calls.fetched.push(url);
      if (options.unreachable?.includes(url)) throw new Error("本文が取れていません（サイトに取得を拒否されました）。");
      return { title: `title of ${url}`, text: `text of ${url}` };
    },
    synthesize: async (prompt) => {
      calls.synthesisPrompts.push(prompt);
      return syntheses.shift() ?? "";
    },
    synthesizeAudio: async (jobDir) => ({ filePath: path.join(jobDir, "n.m4a"), durationSec: 300, sizeBytes: 900_000 }),
    usage: {
      read: async () => options.usage ?? {},
      write: async (usage) => {
        calls.usage.push(usage);
      }
    },
    store: {
      register: async (input) => {
        calls.registered.push(input);
      },
      saveRequest: async () => {},
      saveProgress: async (_url, value: BundleProgress) => {
        calls.progress.push([value.status, value.stage, value.statusMessage].filter(Boolean).join(":"));
      },
      saveSources: async (_url, sources) => {
        calls.sources.push(sources);
      },
      saveSource: async (_url, markdown) => {
        calls.bodies.push(markdown);
      },
      saveTldr: async () => {},
      saveAudio: async () => {
        calls.audio += 1;
      }
    },
    log: () => {}
  };
  return { deps, calls };
}

test("深掘り: 調べる→確かめる→まとめる→登録。元記事そのものは出典にしない", async () => {
  const { deps, calls } = await setup();
  const result = await runResearch({ articleId: "url_base", aspects: ["related", "reception"], audio: true }, deps);
  assert.equal(result.used, 3);
  assert.equal(result.unreachable, 0);
  assert.equal(result.audio, true);
  assert.deepEqual(calls.fetched, ["https://a.example/1", "https://b.example/2", "https://c.example/3"]);
  assert.equal(calls.registered[0]?.title, "元の記事の深掘り（作成中）");
  assert.equal(calls.registered.at(-1)?.title, "深掘りレポート");
  assert.deepEqual(calls.progress, [
    "processing:順番待ち",
    "processing:元記事を確認中",
    "processing:Web を調査中",
    "processing:出典を確認中（1/3）",
    "processing:出典を確認中（2/3）",
    "processing:出典を確認中（3/3）",
    "processing:レポートを作成中",
    "processing:音声を作成中",
    "completed"
  ]);
  assert.deepEqual(calls.usage[0], { "2026-11-21": 1 });
});

test("深掘り(案A): 取得できなかった出典は使わず、その記述をまとめに渡さない。一覧には残す", async () => {
  const { deps, calls } = await setup({ unreachable: ["https://b.example/2"] });
  const result = await runResearch({ articleId: "url_base", aspects: ["related", "reception"] }, deps);
  assert.equal(result.used, 2);
  assert.equal(result.unreachable, 1);
  assert.doesNotMatch(calls.synthesisPrompts[0] ?? "", /B は Y と報じた/);
  assert.match(calls.synthesisPrompts[0] ?? "", /A は X と報じた/);
  assert.deepEqual(calls.sources[0]?.map((source) => `${source.index}:${source.status}`), ["1:used", "2:used", "3:unreachable"]);
  assert.match(calls.bodies[0] ?? "", /## 確認できなかった出典/);
});

test("深掘り: 確認できる出典が2件未満なら、理由つきで失敗する", async () => {
  const { deps, calls } = await setup({ unreachable: ["https://a.example/1", "https://b.example/2"] });
  await assert.rejects(
    runResearch({ articleId: "url_base", aspects: ["related", "reception"] }, deps),
    (error: Error) => error.name === "ResearchError" && /出典が足りませんでした（1件）/.test(error.message)
  );
  assert.match(calls.progress.at(-1) ?? "", /^failed:確認できる出典が足りませんでした/);
  assert.equal(calls.synthesisPrompts.length, 0);
});

test("深掘り: 調査の出力が不正なら1回だけやり直し、2回とも出典が無ければ失敗", async () => {
  const retried = await setup({ investigations: ["壊れた出力", investigation] });
  await runResearch({ articleId: "url_base", aspects: ["related", "reception"] }, retried.deps);
  assert.equal(retried.calls.investigatePrompts.length, 2);

  const empty = await setup({ investigations: ["壊れた出力", JSON.stringify({ findings: [] })] });
  await assert.rejects(runResearch({ articleId: "url_base", aspects: ["related"] }, empty.deps), /出典が見つかりませんでした/);
});

test("深掘り: まとめが2回とも不正なら失敗(理由は一般的な文面にする)", async () => {
  const { deps, calls } = await setup({ synthesisOutputs: ["壊れた", "これも壊れた"] });
  await assert.rejects(runResearch({ articleId: "url_base", aspects: ["related", "reception"] }, deps), /synthesis failed twice/);
  assert.equal(calls.progress.at(-1), "failed:深掘りを作れませんでした。時間をおいて、もう一度お試しください。");
});

test("深掘り: 1日の上限・元記事が無い・束は元にできない・観点が無い", async () => {
  const limited = await setup({ usage: { "2026-11-21": 10 } });
  await assert.rejects(runResearch({ articleId: "url_base", aspects: ["related"] }, limited.deps), /1日10件まで/);
  const missing = await setup({ baseArticle: null });
  await assert.rejects(runResearch({ articleId: "url_base", aspects: ["related"] }, missing.deps), /元の記事が見つかりません/);
  const bundle = await setup({ baseArticle: { articleId: "bnd_x", canonicalUrl: "bundle:bnd_0123456789ab", title: "束", sourceKind: "bundle", deleted: false } });
  await assert.rejects(runResearch({ articleId: "bnd_x", aspects: ["related"] }, bundle.deps), /束や深掘りレポートは/);
  const none = await setup();
  await assert.rejects(runResearch({ articleId: "url_base", aspects: [] }, none.deps), /観点を1つ以上/);
});

test("深掘り: 時間の上限を超えたら失敗にする。作り直しでは仮登録しない", async () => {
  const slow = await setup({ slow: true });
  await assert.rejects(runResearch({ articleId: "url_base", aspects: ["related"] }, slow.deps), /時間内/);
  const again = await setup({ existing: true });
  await runResearch({ articleId: "url_base", aspects: ["related", "reception"] }, again.deps);
  assert.equal(again.calls.registered.length, 1);
});
