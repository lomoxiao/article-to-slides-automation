import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BundleMember, StoredArticleDigest, StoredArticleSummary } from "../../shared/firebaseArticleStore.js";
import { createArticleIdentity, createBundleIdentity, isSyntheticArticleUrl } from "../../shared/identity.js";
import { getOrCreateArticleDigest, hashSource, parseArticleDigest, type ArticleDigestDeps } from "./articleDigest.js";
import {
  appendUncoveredSources,
  buildBundleMarkdown,
  buildSynthesisPrompt,
  findUncoveredSources,
  parseSynthesis,
  usableNarration,
  type BundleSource
} from "./bundleSynthesis.js";
import { runBundle, type BundleDeps } from "./bundlePipeline.js";

// ---- 束のID

test("束のID: 同じ組み合わせなら順序に関係なく同じID。組み合わせが違えば別のID", () => {
  const a = createBundleIdentity(["url_b", "url_a", "yt_c"]);
  const b = createBundleIdentity(["yt_c", "url_a", "url_b", "url_a"]);
  assert.equal(a.articleId, b.articleId);
  assert.match(a.articleId, /^bnd_[0-9a-f]{12}$/);
  assert.equal(a.canonicalUrl, `bundle:${a.articleId}`);
  assert.equal(a.sourceKind, "bundle");
  assert.notEqual(a.articleId, createBundleIdentity(["url_a", "url_b"]).articleId);
});

test("束のID: 疑似URLから同じIDに戻せる。通常のURLの扱いは変わらない", () => {
  const bundle = createBundleIdentity(["url_a", "url_b"]);
  assert.deepEqual(createArticleIdentity(bundle.canonicalUrl), bundle);
  assert.equal(isSyntheticArticleUrl(bundle.canonicalUrl), true);
  assert.equal(isSyntheticArticleUrl("text:txt_0123456789ab"), true);
  assert.equal(isSyntheticArticleUrl("https://example.com/a"), false);
  assert.equal(createArticleIdentity("https://example.com/a").sourceKind, "web");
});

// ---- 記事ごとの要点

const digestJson = JSON.stringify({
  summary: "この記事は、ある技術の概要と使いどころを説明している。",
  points: ["要点その1", "要点その2", "要点その3"]
});

function digestDeps(stored?: StoredArticleDigest, outputs: string[] = [digestJson]) {
  const calls = { prompts: 0, saved: [] as string[] };
  const deps: ArticleDigestDeps = {
    load: async () => stored,
    save: async (articleId) => {
      calls.saved.push(articleId);
    },
    runPrompt: async () => {
      calls.prompts += 1;
      return { result: outputs.shift() ?? "" };
    }
  };
  return { deps, calls };
}

test("要点: 保存済みで本文が同じなら AI を呼ばずに再利用する", async () => {
  const markdown = "本文".repeat(100);
  const { deps, calls } = digestDeps({ summary: "保存済みの要約", points: ["a", "b", "c"], sourceHash: hashSource(markdown) });
  const digest = await getOrCreateArticleDigest({ articleId: "url_a", title: "t", markdown, jobDir: "." }, deps);
  assert.equal(digest.reused, true);
  assert.equal(digest.summary, "保存済みの要約");
  assert.equal(calls.prompts, 0);
});

test("要点: 保存が無い・本文が変わった場合は作り直して保存する", async () => {
  const fresh = digestDeps(undefined);
  const created = await getOrCreateArticleDigest({ articleId: "url_a", title: "t", markdown: "新しい本文", jobDir: "." }, fresh.deps);
  assert.equal(created.reused, false);
  assert.equal(created.sourceHash, hashSource("新しい本文"));
  assert.deepEqual(fresh.calls.saved, ["url_a"]);

  const changed = digestDeps({ summary: "古い", points: ["a", "b", "c"], sourceHash: hashSource("古い本文") });
  await getOrCreateArticleDigest({ articleId: "url_a", title: "t", markdown: "新しい本文", jobDir: "." }, changed.deps);
  assert.equal(changed.calls.prompts, 1);
});

test("要点: 出力が不正なら1回だけ再実行し、2回とも不正なら例外", async () => {
  const retry = digestDeps(undefined, ["壊れた出力", digestJson]);
  await getOrCreateArticleDigest({ articleId: "url_a", title: "t", markdown: "本文", jobDir: "." }, retry.deps);
  assert.equal(retry.calls.prompts, 2);

  const broken = digestDeps(undefined, ["壊れた出力", JSON.stringify({ summary: "短", points: [] })]);
  await assert.rejects(
    getOrCreateArticleDigest({ articleId: "url_a", title: "t", markdown: "本文", jobDir: "." }, broken.deps),
    /validation failed twice/
  );
  assert.throws(() => parseArticleDigest(JSON.stringify({ summary: "十分な長さのある要約の文章です。これで20字を超えます。", points: ["a", "b"] })));
});

// ---- 統合

const sources: BundleSource[] = [
  { index: 1, articleId: "url_a", title: "記事A", url: "https://example.com/a", summary: "Aの要約", points: ["A1", "A2", "A3"] },
  { index: 2, articleId: "url_b", title: "記事B", url: "https://example.com/b", summary: "Bの要約", points: ["B1", "B2", "B3"] },
  { index: 3, articleId: "txt_c", title: "メモC", url: "", summary: "Cの要約", points: ["C1", "C2", "C3"] }
];
const narration = `今週のまとめです。\n${"三つの記事に共通する点をお伝えします。".repeat(40)}`;
const synthesisJson = (sectionSources: number[][]) =>
  JSON.stringify({
    title: "三つの記事のまとめ",
    tldr: ["- 一つ目", "二つ目", "三つ目"],
    sections: sectionSources.map((numbers, i) => ({ heading: `節${i + 1}`, body: `節${i + 1}の本文。`, sources: numbers })),
    narration
  });

test("統合: 出力を検証し、どの節にも現れなかった記事を見つける", () => {
  const synthesis = parseSynthesis(synthesisJson([[1, 2], [2]]), 3);
  assert.deepEqual(synthesis.tldr, ["一つ目", "二つ目", "三つ目"]);
  assert.deepEqual(findUncoveredSources(synthesis, 3), [3]);
  assert.deepEqual(findUncoveredSources(parseSynthesis(synthesisJson([[1, 3], [2]]), 3), 3), []);
});

test("統合: 存在しない記事番号・形式違いは拒否する", () => {
  assert.throws(() => parseSynthesis(synthesisJson([[1, 4]]), 3), /unknown article numbers/);
  assert.throws(() => parseSynthesis("JSONではない", 3));
  assert.throws(() => parseSynthesis(JSON.stringify({ title: "t", tldr: ["a"], sections: [] }), 3));
});

test("統合: 落ちた記事は「その他の記事」として機械的に足す", () => {
  const synthesis = parseSynthesis(synthesisJson([[1, 2]]), 3);
  const completed = appendUncoveredSources(synthesis, sources, [3]);
  assert.equal(completed.sections.at(-1)?.heading, "その他の記事");
  assert.match(completed.sections.at(-1)?.body ?? "", /メモC: Cの要約/);
  assert.deepEqual(findUncoveredSources(completed, 3), []);
  assert.equal(appendUncoveredSources(synthesis, sources, []), synthesis);
});

test("統合: プロンプトは材料を信頼できない入力として扱い、再実行時は欠けた番号を伝える", () => {
  const prompt = buildSynthesisPrompt(sources, { missingNumbers: [3] });
  assert.match(prompt, /信頼できない入力データ/);
  assert.match(prompt, /\[3\] がどの節の sources にも入っていませんでした/);
  assert.match(prompt, /\[1\] 記事A/);
});

test("統合: 読み上げ原稿は長さとURLなしを満たすものだけ使う", () => {
  assert.equal(usableNarration(narration), narration);
  assert.equal(usableNarration("短い"), undefined);
  assert.equal(usableNarration(`${narration} https://example.com`), undefined);
  assert.equal(usableNarration(undefined), undefined);
});

test("本文: 節・出典・含めた記事・含められなかった記事を組み立てる", () => {
  const members: BundleMember[] = [
    { articleId: "url_a", title: "記事A", canonicalUrl: "https://example.com/a", status: "included" },
    { articleId: "url_x", title: "記事X", canonicalUrl: "https://example.com/x", status: "missing", reason: "サイトに取得を拒否されました" }
  ];
  const body = buildBundleMarkdown(parseSynthesis(synthesisJson([[1, 3], [2]]), 3), sources, members);
  const blocks = body.split("\n\n");
  assert.deepEqual(blocks.filter((block) => block.startsWith("## ")), ["## 節1", "## 節2", "## この束に含まれる記事", "## 含められなかった記事"]);
  assert.ok(blocks.includes("出典: [1] 記事A / [3] メモC"));
  assert.ok(body.includes("- [1] 記事A https://example.com/a"));
  // テキスト投入の記事は URL を出さない
  assert.ok(body.includes("- [3] メモC\n") || body.endsWith("- [3] メモC") || body.includes("- [3] メモC\n\n"));
  assert.ok(body.includes("- 記事X（サイトに取得を拒否されました）"));
});

// ---- 束の作成全体

const article = (articleId: string, overrides: Partial<StoredArticleSummary> = {}): StoredArticleSummary => ({
  articleId,
  canonicalUrl: `https://example.com/${articleId}`,
  title: `記事 ${articleId}`,
  sourceKind: "web",
  deleted: false,
  ...overrides
});

async function setup(options: {
  articles?: Record<string, StoredArticleSummary | undefined>;
  failSource?: string[];
  failDigest?: string[];
  synthesisOutputs?: string[];
  audioFails?: boolean;
} = {}) {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), "bundle-test-"));
  const calls = {
    digests: [] as string[],
    prompts: [] as string[],
    registered: [] as Array<{ url: string; title: string; headline: string }>,
    sources: [] as string[],
    tldrs: [] as string[],
    members: [] as BundleMember[][],
    audio: 0
  };
  const outputs = options.synthesisOutputs ?? [synthesisJson([[1, 2, 3]])];
  const deps: BundleDeps = {
    maxMembers: 10,
    jobsRoot,
    getArticle: async (articleId) =>
      options.articles && articleId in options.articles ? options.articles[articleId] : article(articleId),
    loadSource: async (item) => {
      if (options.failSource?.includes(item.articleId)) {
        throw new Error("本文が取れていません（サイトに取得を拒否されました）。記事をコピーして、テキスト投入をお試しください。");
      }
      return { title: item.title, text: `${item.articleId} の本文` };
    },
    digest: async (input) => {
      calls.digests.push(input.articleId);
      if (options.failDigest?.includes(input.articleId)) throw new Error("article digest validation failed twice");
      return { summary: `${input.articleId} の要約`, points: ["p1", "p2", "p3"], sourceHash: "h", reused: false };
    },
    runPrompt: async (input) => {
      calls.prompts.push(input.prompt);
      return { result: outputs.shift() ?? "" };
    },
    synthesizeAudio: async (jobDir) => {
      if (options.audioFails) throw new Error("TTS environment missing");
      return { filePath: path.join(jobDir, "narration.m4a"), durationSec: 200, sizeBytes: 800_000 };
    },
    store: {
      register: async (input) => {
        calls.registered.push(input);
      },
      saveSource: async (_url, markdown) => {
        calls.sources.push(markdown);
      },
      saveTldr: async (_url, tldr) => {
        calls.tldrs.push(tldr);
      },
      saveMembers: async (_url, members) => {
        calls.members.push(members);
      },
      saveAudio: async () => {
        calls.audio += 1;
      }
    },
    log: () => {}
  };
  return { deps, calls };
}

test("束: 記事ごとに要点を取り、統合して登録する", async () => {
  const { deps, calls } = await setup();
  const result = await runBundle({ memberIds: ["url_a", "url_b", "url_c"], audio: true }, deps);

  assert.equal(result.articleId, createBundleIdentity(["url_a", "url_b", "url_c"]).articleId);
  assert.equal(result.included, 3);
  assert.equal(result.missing, 0);
  assert.equal(result.audio, true);
  assert.equal(result.digestsCreated, 3);
  assert.deepEqual(calls.digests, ["url_a", "url_b", "url_c"]);
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.registered[0]?.url, result.url);
  assert.equal(calls.registered[0]?.headline, "一つ目");
  assert.equal(calls.tldrs[0], "- 一つ目\n- 二つ目\n- 三つ目");
  assert.equal(calls.audio, 1);
  assert.deepEqual(calls.members[0]?.map((member) => member.status), ["included", "included", "included"]);
});

test("束: 取れない記事があっても、取れた記事で作り、欠けた記事を理由つきで明示する", async () => {
  const { deps, calls } = await setup({ failSource: ["url_b"], synthesisOutputs: [synthesisJson([[1, 2]])] });
  const result = await runBundle({ memberIds: ["url_a", "url_b", "url_c"] }, deps);

  assert.equal(result.included, 2);
  assert.equal(result.missing, 1);
  const members = calls.members[0] ?? [];
  assert.deepEqual(members.map((member) => `${member.articleId}:${member.status}`), ["url_a:included", "url_b:missing", "url_c:included"]);
  assert.equal(members[1]?.reason, "サイトに取得を拒否されました");
  assert.match(result.body, /## 含められなかった記事/);
  assert.match(result.body, /記事 url_b（サイトに取得を拒否されました）/);
  assert.deepEqual(calls.digests, ["url_a", "url_c"]);
});

test("束: 見つからない記事・削除済みの記事・束そのものは含めない", async () => {
  const { deps, calls } = await setup({
    articles: {
      url_gone: undefined,
      url_del: article("url_del", { deleted: true }),
      bnd_x: article("bnd_x", { sourceKind: "bundle", canonicalUrl: "bundle:bnd_0123456789ab" })
    },
    synthesisOutputs: [synthesisJson([[1, 2]])]
  });
  const result = await runBundle({ memberIds: ["url_a", "url_gone", "url_del", "bnd_x", "url_b"] }, deps);
  assert.equal(result.included, 2);
  assert.equal(result.missing, 3);
  assert.deepEqual(calls.digests, ["url_a", "url_b"]);
});

test("束: 含められる記事が2本未満なら作らず、理由つきで失敗する", async () => {
  const { deps, calls } = await setup({ failSource: ["url_b", "url_c"] });
  await assert.rejects(
    runBundle({ memberIds: ["url_a", "url_b", "url_c"] }, deps),
    (error: Error) => error.name === "BundleError" && /2本未満/.test(error.message) && /取得を拒否/.test(error.message)
  );
  assert.equal(calls.registered.length, 0);
  assert.equal(calls.prompts.length, 0);
});

test("束: 要点を抽出できなかった記事も「含められなかった」に回す", async () => {
  const { deps, calls } = await setup({ failDigest: ["url_c"], synthesisOutputs: [synthesisJson([[1, 2]])] });
  const result = await runBundle({ memberIds: ["url_a", "url_b", "url_c"] }, deps);
  assert.equal(result.included, 2);
  assert.equal(calls.members[0]?.find((member) => member.articleId === "url_c")?.reason, "要点を抽出できませんでした");
});

test("束: 統合で記事が落ちたら1回だけ再実行し、それでも落ちたら機械的に足す(記事を落とさない)", async () => {
  const retried = await setup({ synthesisOutputs: [synthesisJson([[1, 2]]), synthesisJson([[1, 2], [3]])] });
  const ok = await runBundle({ memberIds: ["url_a", "url_b", "url_c"] }, retried.deps);
  assert.equal(retried.calls.prompts.length, 2);
  assert.match(retried.calls.prompts[1] ?? "", /\[3\] がどの節の sources にも入っていません/);
  assert.doesNotMatch(ok.body, /その他の記事/);

  const stillMissing = await setup({ synthesisOutputs: [synthesisJson([[1, 2]]), synthesisJson([[1], [2]])] });
  const appended = await runBundle({ memberIds: ["url_a", "url_b", "url_c"] }, stillMissing.deps);
  assert.equal(stillMissing.calls.prompts.length, 2);
  assert.match(appended.body, /## その他の記事/);
  assert.match(appended.body, /記事 url_c: url_c の要約/);
});

test("束: 統合の出力が2回とも不正なら失敗し、何も登録しない", async () => {
  const { deps, calls } = await setup({ synthesisOutputs: ["壊れた出力", "これも壊れている"] });
  await assert.rejects(runBundle({ memberIds: ["url_a", "url_b"] }, deps), /synthesis failed twice/);
  assert.equal(calls.registered.length, 0);
});

test("束: 音声だけ失敗しても束は登録する。音声を頼まなければ作らない", async () => {
  const failed = await setup({ audioFails: true });
  const result = await runBundle({ memberIds: ["url_a", "url_b", "url_c"], audio: true }, failed.deps);
  assert.equal(result.audio, false);
  assert.match(result.audioError ?? "", /TTS environment missing/);
  assert.equal(failed.calls.registered.length, 1);

  const noAudio = await setup();
  const silent = await runBundle({ memberIds: ["url_a", "url_b", "url_c"] }, noAudio.deps);
  assert.equal(silent.audio, false);
  assert.equal(noAudio.calls.audio, 0);
});

test("束: 本数の下限・上限と重複", async () => {
  const { deps } = await setup();
  await assert.rejects(runBundle({ memberIds: ["url_a"] }, deps), /2本以上/);
  await assert.rejects(runBundle({ memberIds: ["url_a", "url_a"] }, deps), /2本以上/);
  await assert.rejects(
    runBundle({ memberIds: Array.from({ length: 11 }, (_, i) => `url_${i}`) }, deps),
    /10本まで/
  );
});

test("束: タイトルを指定すればそれを使う", async () => {
  const { deps, calls } = await setup();
  const result = await runBundle({ memberIds: ["url_a", "url_b", "url_c"], title: "今週のAIまとめ" }, deps);
  assert.equal(result.title, "今週のAIまとめ");
  assert.equal(calls.registered[0]?.title, "今週のAIまとめ");
});
