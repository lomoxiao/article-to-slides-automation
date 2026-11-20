import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { runCodexPrompt, runCodexResearchPrompt } from "../../shared/codexRunner.js";
import {
  getArticleSummary,
  registerArticle,
  upsertArticleSource,
  upsertArticleTldr,
  upsertResearchProgress,
  upsertResearchRequest,
  upsertResearchSources,
  type BundleProgress,
  type ResearchSourceRecord,
  type StoredArticleSummary
} from "../../shared/firebaseArticleStore.js";
import { createResearchIdentity, isSyntheticArticleUrl } from "../../shared/identity.js";
import { AsyncSemaphore } from "../../shared/resourceSemaphore.js";
import { fetchSourceContent } from "../../shared/sourceAggregator.js";
import { usableNarration } from "../bundle/bundleSynthesis.js";
import { getOrCreateArticleDigest } from "../bundle/articleDigest.js";
import { saveArticleAudioFile, synthesizeDigestAudio, type DigestAudio } from "../digest/digestAudio.js";
import { ingestArticle } from "../ingest/ingestArticle.js";
import { aspectLabel } from "./researchAspects.js";
import {
  buildInvestigatePrompt,
  buildResearchMarkdown,
  buildSynthesizePrompt,
  parseFindings,
  parseResearchSynthesis,
  type BaseArticle,
  type ResearchFinding,
  type ResearchSynthesis,
  type VerifiedSource
} from "./researchReport.js";

/**
 * 深掘りリサーチ(方式は decisions/2026-11-21-catchup-research-method: Codex の cached 検索・案A)。
 *  1. 元記事の要約と要点を用意する
 *  2. 調べる: Codex(read-only・cached 検索)が観点ごとに「事実＋出典 URL」を挙げる
 *  3. 確かめる: プログラムが出典 URL を取得する(AI なし)。取得できなかった出典に基づく記述は外す
 *  4. まとめる: Codex(Web なし・書き込みなし)が、取得できた本文だけを材料にレポートを書く
 *  5. 登録する: 深掘りレポートを「合成された記事」(research:rsc_…)として登録する。音声は任意
 */
export const RESEARCH_MIN_SOURCES = 2;

/** 利用者に見せてよい理由つきの失敗。 */
export class ResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchError";
  }
}

export function isResearchError(error: unknown): error is ResearchError {
  return error instanceof Error && error.name === "ResearchError";
}

export type ResearchInput = {
  articleId: string;
  aspects: string[];
  note?: string;
  audio?: boolean;
  vaultCandidate?: boolean;
};

export type ResearchResult = {
  articleId: string;
  url: string;
  title: string;
  used: number;
  unreachable: number;
  audio: boolean;
  audioError?: string;
};

export type ResearchDeps = {
  maxSources: number;
  maxPerDay: number;
  timeoutMs: number;
  jobsRoot: string;
  now: () => Date;
  getArticle: (articleId: string) => Promise<StoredArticleSummary | undefined>;
  loadBase: (article: StoredArticleSummary, jobDir: string) => Promise<BaseArticle>;
  investigate: (prompt: string, jobDir: string, label: string) => Promise<string>;
  fetchSource: (url: string) => Promise<{ title: string; text: string }>;
  synthesize: (prompt: string, jobDir: string, label: string) => Promise<string>;
  synthesizeAudio: (jobDir: string, narration: string) => Promise<DigestAudio>;
  usage: { read: () => Promise<Record<string, number>>; write: (usage: Record<string, number>) => Promise<void> };
  store: {
    register: (input: { url: string; title: string; headline: string }) => Promise<unknown>;
    saveRequest: (url: string, request: { baseArticleId: string; aspects: string[]; note: string; vaultCandidate: boolean }) => Promise<void>;
    saveProgress: (url: string, progress: BundleProgress) => Promise<void>;
    saveSources: (url: string, sources: ResearchSourceRecord[]) => Promise<void>;
    saveSource: (url: string, markdown: string, title: string) => Promise<void>;
    saveTldr: (url: string, tldr: string) => Promise<void>;
    saveAudio: (url: string, audio: DigestAudio) => Promise<void>;
  };
  log: (message: string) => void;
};

function jstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function defaultResearchDeps(): ResearchDeps {
  const usagePath = path.resolve(".runtime", "research-usage.json");
  return {
    maxSources: config.research.maxSources,
    maxPerDay: config.research.maxPerDay,
    timeoutMs: config.research.timeoutMin * 60_000,
    jobsRoot: path.join("jobs", "research"),
    now: () => new Date(),
    getArticle: getArticleSummary,
    loadBase: async (article, jobDir) => {
      const source = await ingestArticle(article.canonicalUrl);
      const digest = await getOrCreateArticleDigest({
        articleId: article.articleId,
        title: article.title || source.title,
        markdown: source.text,
        jobDir
      });
      return {
        title: article.title || source.title,
        url: isSyntheticArticleUrl(article.canonicalUrl) ? "" : article.canonicalUrl,
        summary: digest.summary,
        points: digest.points
      };
    },
    investigate: async (prompt, jobDir, label) =>
      (await runCodexResearchPrompt({ prompt, jobDir, logLabel: label, webSearch: "cached" })).result,
    fetchSource: async (url) => {
      const source = await fetchSourceContent(url);
      return { title: source.title, text: source.text };
    },
    synthesize: async (prompt, jobDir, label) => (await runCodexPrompt({ prompt, jobDir, logLabel: label })).result,
    synthesizeAudio: synthesizeDigestAudio,
    usage: {
      read: async () => {
        try {
          return JSON.parse(await readFile(usagePath, "utf8")) as Record<string, number>;
        } catch {
          return {};
        }
      },
      write: async (usage) => {
        await mkdir(path.dirname(usagePath), { recursive: true });
        await writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`, "utf8");
      }
    },
    store: {
      register: (input) => registerArticle({ ...input, registeredFrom: "research" }),
      saveRequest: upsertResearchRequest,
      saveProgress: upsertResearchProgress,
      saveSources: upsertResearchSources,
      saveSource: (url, markdown, title) => upsertArticleSource(url, markdown, { version: 2, method: "research_synthesis", title }),
      saveTldr: upsertArticleTldr,
      saveAudio: saveArticleAudioFile
    },
    log: (message) => console.log(`[research] ${message}`)
  };
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/本文が取れていません（([^）]+)）/);
  return (match?.[1] ?? message).replace(/\s+/g, " ").slice(0, 120);
}

/** 深掘りは同時に1件だけ(調べる・まとめるの AI 実行が長いため)。 */
const researchSemaphore = new AsyncSemaphore();

export async function runResearch(input: ResearchInput, deps: ResearchDeps = defaultResearchDeps()): Promise<ResearchResult> {
  const aspects = [...new Set(input.aspects)];
  if (!aspects.length) throw new ResearchError("深掘りの観点を1つ以上選んでください。");
  const note = (input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const identity = createResearchIdentity(input.articleId, aspects, note);
  const progress = (value: BundleProgress) => deps.store.saveProgress(identity.canonicalUrl, value).catch(() => {});

  // 1日の上限(数えるのは依頼を受け付けた件数)
  const today = jstDate(deps.now());
  const usage = await deps.usage.read().catch(() => ({}) as Record<string, number>);
  if ((usage[today] ?? 0) >= deps.maxPerDay) {
    throw new ResearchError(`深掘りは1日${deps.maxPerDay}件までです。明日もう一度お試しください。`);
  }
  const keep = Object.keys({ ...usage, [today]: 0 }).sort().slice(-14);
  const nextUsage = Object.fromEntries(keep.map((day) => [day, day === today ? (usage[today] ?? 0) + 1 : usage[day] ?? 0]));
  await deps.usage.write(nextUsage).catch(() => {});

  // 作り始めた時点で一覧に出す(作り直しなら前回の内容を残したまま「作成中」だけ付ける)
  const base = await deps.getArticle(input.articleId);
  if (!base || base.deleted) throw new ResearchError("元の記事が見つかりません。");
  if (base.sourceKind === "bundle" || base.sourceKind === "research") {
    throw new ResearchError("束や深掘りレポートは、深掘りの元にできません。");
  }
  try {
    if (!(await deps.getArticle(identity.articleId))) {
      await deps.store.register({
        url: identity.canonicalUrl,
        title: `${base.title || "記事"}の深掘り（作成中）`.slice(0, 120),
        headline: aspects.map(aspectLabel).join("・")
      });
    }
    await deps.store.saveRequest(identity.canonicalUrl, {
      baseArticleId: input.articleId,
      aspects,
      note,
      vaultCandidate: Boolean(input.vaultCandidate)
    });
  } catch (error) {
    deps.log(`early registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await progress({ status: "processing", stage: "順番待ち" });

  try {
    const result = await researchSemaphore.runExclusive(() =>
      withDeadline(deps.timeoutMs, () =>
        buildResearch(input, aspects, note, base, identity.canonicalUrl, identity.articleId, deps, (stage) =>
          progress({ status: "processing", stage })
        )
      )
    );
    await progress({ status: "completed" });
    return result;
  } catch (error) {
    await progress({
      status: "failed",
      statusMessage: isResearchError(error) ? error.message : "深掘りを作れませんでした。時間をおいて、もう一度お試しください。"
    });
    throw error;
  }
}

async function withDeadline<T>(ms: number, task: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ResearchError(`深掘りが時間内(${Math.round(ms / 60000)}分)に終わりませんでした。`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildResearch(
  input: ResearchInput,
  aspects: string[],
  note: string,
  baseArticle: StoredArticleSummary,
  url: string,
  researchId: string,
  deps: ResearchDeps,
  setStage: (stage: string) => Promise<void>
): Promise<ResearchResult> {
  const jobDir = path.join(deps.jobsRoot, researchId);
  await mkdir(jobDir, { recursive: true });

  // 1. 元記事
  await setStage("元記事を確認中");
  let base: BaseArticle;
  try {
    base = await deps.loadBase(baseArticle, jobDir);
  } catch (error) {
    throw new ResearchError(`元の記事を読めませんでした（${reasonOf(error)}）。`);
  }

  // 2. 調べる(Codex・read-only・cached 検索)。出力が不正なら1回だけやり直す
  await setStage("Web を調査中");
  let findings: ResearchFinding[] = [];
  for (const attempt of [1, 2]) {
    try {
      findings = parseFindings(await deps.investigate(buildInvestigatePrompt(base, aspects, note), jobDir, `investigate-${attempt}`), aspects);
      if (findings.length) break;
    } catch (error) {
      deps.log(`investigate attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const baseUrl = base.url;
  findings = findings.filter((finding) => finding.sourceUrl !== baseUrl);
  if (!findings.length) throw new ResearchError("Web の調査で出典が見つかりませんでした。観点を変えてお試しください。");

  // 3. 確かめる(AI なし)。取得できた出典だけを使う
  const urls = [...new Set(findings.map((finding) => finding.sourceUrl))].slice(0, deps.maxSources);
  const sources: VerifiedSource[] = [];
  const unreachable: Array<{ url: string; reason: string }> = [];
  for (const [position, sourceUrl] of urls.entries()) {
    await setStage(`出典を確認中（${position + 1}/${urls.length}）`);
    try {
      const fetched = await deps.fetchSource(sourceUrl);
      sources.push({ index: sources.length + 1, url: sourceUrl, title: fetched.title || sourceUrl, text: fetched.text });
    } catch (error) {
      unreachable.push({ url: sourceUrl, reason: reasonOf(error) });
    }
  }
  const records: ResearchSourceRecord[] = [
    ...sources.map((source) => ({ index: source.index, title: source.title, url: source.url, status: "used" as const })),
    ...unreachable.map((item, i) => ({ index: sources.length + i + 1, title: item.url, url: item.url, status: "unreachable" as const, reason: item.reason }))
  ];
  await deps.store.saveSources(url, records).catch(() => {});
  if (sources.length < RESEARCH_MIN_SOURCES) {
    throw new ResearchError(`確認できる出典が足りませんでした（${sources.length}件）。観点を変えてお試しください。`);
  }
  // 案A: 取得できなかった出典に基づく記述は外す
  const usedFindings = findings
    .map((finding) => ({ ...finding, sourceIndex: sources.find((source) => source.url === finding.sourceUrl)?.index ?? 0 }))
    .filter((finding) => finding.sourceIndex > 0);

  // 4. まとめる(Codex・Web なし)。出力が不正なら1回だけやり直す
  await setStage("レポートを作成中");
  let synthesis: ResearchSynthesis | undefined;
  let lastError: unknown;
  for (const attempt of [1, 2]) {
    try {
      synthesis = parseResearchSynthesis(
        await deps.synthesize(buildSynthesizePrompt(base, aspects, usedFindings, sources), jobDir, `synthesis-${attempt}`),
        sources.length
      );
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!synthesis) {
    throw new Error(`research synthesis failed twice: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  const title = synthesis.title.slice(0, 120);
  const body = buildResearchMarkdown(base, synthesis, sources, unreachable);
  await writeFile(path.join(jobDir, "body.md"), `${body}\n`, "utf8");
  await writeFile(path.join(jobDir, "research.json"), `${JSON.stringify({ title, aspects, note, findings, synthesis, unreachable }, null, 2)}\n`, "utf8");

  // 音声(任意)。失敗してもレポートは作る
  let audio: DigestAudio | undefined;
  let audioError: string | undefined;
  if (input.audio) {
    const narration = usableNarration(synthesis.narration);
    if (!narration) {
      audioError = "読み上げ原稿が規定の長さに収まりませんでした";
    } else {
      try {
        await setStage("音声を作成中");
        audio = await deps.synthesizeAudio(jobDir, narration);
      } catch (error) {
        audioError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      }
    }
  }

  // 5. 登録
  await deps.store.register({ url, title, headline: synthesis.tldr[0] });
  await deps.store.saveSource(url, body, title);
  await deps.store.saveTldr(url, synthesis.tldr.map((line) => `- ${line}`).join("\n"));
  if (audio) {
    try {
      await deps.store.saveAudio(url, audio);
    } catch (error) {
      audioError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      audio = undefined;
    }
  }
  deps.log(`research ${researchId}: sources=${sources.length} unreachable=${unreachable.length} audio=${Boolean(audio)}`);
  return {
    articleId: researchId,
    url,
    title,
    used: sources.length,
    unreachable: unreachable.length,
    audio: Boolean(audio),
    ...(audioError ? { audioError } : {})
  };
}
