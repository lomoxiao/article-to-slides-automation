import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { runCodexPrompt } from "../../shared/codexRunner.js";
import {
  getArticleSummary,
  registerArticle,
  upsertArticleSource,
  upsertArticleTldr,
  upsertBundleMembers,
  type BundleMember,
  type StoredArticleSummary
} from "../../shared/firebaseArticleStore.js";
import { createBundleIdentity, isSyntheticArticleUrl } from "../../shared/identity.js";
import { saveArticleAudioFile, synthesizeDigestAudio, type DigestAudio } from "../digest/digestAudio.js";
import { ingestArticle } from "../ingest/ingestArticle.js";
import { getOrCreateArticleDigest, type ArticleDigest } from "./articleDigest.js";
import {
  appendUncoveredSources,
  buildBundleMarkdown,
  buildSynthesisPrompt,
  findUncoveredSources,
  parseSynthesis,
  usableNarration,
  type BundleSource,
  type BundleSynthesis
} from "./bundleSynthesis.js";

/**
 * 束(複数記事のまとめ)を作る。
 *  1. メンバー記事の本文を用意する(取れない記事があっても、取れた記事で続ける)
 *  2. 記事ごとに要点を抽出する(保存済みなら再利用)
 *  3. 要点を統合して、3行要約・本文・読み上げ原稿を作る(Codex 1回)
 *  4. 束を「合成された記事」として登録する(同じ組み合わせなら同じ束に上書き)
 */
export const BUNDLE_MIN_MEMBERS = 2;

/** 利用者に見せてよい理由つきの失敗(束にできる記事が足りない、など)。 */
export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

export function isBundleError(error: unknown): error is BundleError {
  return error instanceof Error && error.name === "BundleError";
}

export type BundleInput = { memberIds: string[]; title?: string; audio?: boolean };

export type BundleResult = {
  articleId: string;
  url: string;
  title: string;
  body: string;
  included: number;
  missing: number;
  audio: boolean;
  audioError?: string;
  /** 新たに要点抽出(AI実行)を行った記事数。保存済みを再利用した分は含まない。 */
  digestsCreated: number;
};

export type BundleDeps = {
  maxMembers: number;
  jobsRoot: string;
  getArticle: (articleId: string) => Promise<StoredArticleSummary | undefined>;
  loadSource: (article: StoredArticleSummary) => Promise<{ title: string; text: string }>;
  digest: (input: { articleId: string; title: string; markdown: string; jobDir: string }) => Promise<ArticleDigest & { reused: boolean }>;
  runPrompt: (input: { prompt: string; jobDir: string; logLabel: string }) => Promise<{ result: string }>;
  synthesizeAudio: (jobDir: string, narration: string) => Promise<DigestAudio>;
  store: {
    register: (input: { url: string; title: string; headline: string }) => Promise<unknown>;
    saveSource: (url: string, markdown: string, title: string) => Promise<void>;
    saveTldr: (url: string, tldr: string) => Promise<void>;
    saveMembers: (url: string, members: BundleMember[]) => Promise<void>;
    saveAudio: (url: string, audio: DigestAudio) => Promise<void>;
  };
  log: (message: string) => void;
};

export function defaultBundleDeps(): BundleDeps {
  return {
    maxMembers: config.bundle.maxMembers,
    jobsRoot: path.join("jobs", "bundle"),
    getArticle: getArticleSummary,
    // URL の記事は取り込み工程(保存済みがあれば再利用、無ければ取得)。テキスト投入は保存済み本文のみ
    loadSource: async (article) => {
      const source = await ingestArticle(article.canonicalUrl);
      return { title: source.title, text: source.text };
    },
    digest: (input) => getOrCreateArticleDigest(input),
    runPrompt: runCodexPrompt,
    synthesizeAudio: synthesizeDigestAudio,
    store: {
      register: (input) => registerArticle({ ...input, registeredFrom: "bundle" }),
      saveSource: (url, markdown, title) =>
        upsertArticleSource(url, markdown, { version: 2, method: "bundle_synthesis", title }),
      saveTldr: upsertArticleTldr,
      saveMembers: upsertBundleMembers,
      saveAudio: saveArticleAudioFile
    },
    log: (message) => console.log(`[bundle] ${message}`)
  };
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // 「本文が取れていません（理由）。…」の理由部分だけを使う
  const match = message.match(/本文が取れていません（([^）]+)）/);
  return (match?.[1] ?? message).replace(/\s+/g, " ").slice(0, 120);
}

type Candidate = { article: StoredArticleSummary; text: string; title: string };

export async function runBundle(input: BundleInput, deps: BundleDeps = defaultBundleDeps()): Promise<BundleResult> {
  const memberIds = [...new Set(input.memberIds)];
  if (memberIds.length < BUNDLE_MIN_MEMBERS) throw new BundleError("束にする記事を2本以上選んでください。");
  if (memberIds.length > deps.maxMembers) throw new BundleError(`束にできる記事は${deps.maxMembers}本までです。`);

  const identity = createBundleIdentity(memberIds);
  const jobDir = path.join(deps.jobsRoot, identity.articleId);
  await mkdir(jobDir, { recursive: true });

  const members: BundleMember[] = [];
  const miss = (articleId: string, title: string, canonicalUrl: string, reason: string) =>
    members.push({ articleId, title, canonicalUrl, status: "missing", reason });

  // 1. 本文の用意(部分成功): 取れない記事は理由を記録して先へ進む
  const loaded = await Promise.allSettled(
    memberIds.map(async (articleId): Promise<Candidate | undefined> => {
      const article = await deps.getArticle(articleId);
      if (!article || article.deleted) {
        miss(articleId, article?.title ?? articleId, article?.canonicalUrl ?? "", "記事が見つかりません");
        return undefined;
      }
      if (article.sourceKind === "bundle") {
        miss(articleId, article.title, article.canonicalUrl, "束は束に入れられません");
        return undefined;
      }
      try {
        const source = await deps.loadSource(article);
        return { article, text: source.text, title: article.title || source.title };
      } catch (error) {
        miss(articleId, article.title, article.canonicalUrl, reasonOf(error));
        return undefined;
      }
    })
  );
  const candidates = loaded
    .map((result) => (result.status === "fulfilled" ? result.value : undefined))
    .filter((value): value is Candidate => Boolean(value))
    // 依頼された順(memberIds の順)に並べ直す
    .sort((a, b) => memberIds.indexOf(a.article.articleId) - memberIds.indexOf(b.article.articleId));

  // 2. 記事ごとの要点抽出(AI 実行は1本ずつ流れる)。抽出できなかった記事も「含められなかった」に回す
  const sources: BundleSource[] = [];
  let digestsCreated = 0;
  for (const candidate of candidates) {
    try {
      const digest = await deps.digest({
        articleId: candidate.article.articleId,
        title: candidate.title,
        markdown: candidate.text,
        jobDir
      });
      if (!digest.reused) digestsCreated += 1;
      sources.push({
        index: sources.length + 1,
        articleId: candidate.article.articleId,
        title: candidate.title,
        url: isSyntheticArticleUrl(candidate.article.canonicalUrl) ? "" : candidate.article.canonicalUrl,
        summary: digest.summary,
        points: digest.points
      });
      members.push({
        articleId: candidate.article.articleId,
        title: candidate.title,
        canonicalUrl: candidate.article.canonicalUrl,
        status: "included"
      });
    } catch (error) {
      deps.log(`digest failed for ${candidate.article.articleId}: ${error instanceof Error ? error.message : String(error)}`);
      miss(candidate.article.articleId, candidate.title, candidate.article.canonicalUrl, "要点を抽出できませんでした");
    }
  }
  if (sources.length < BUNDLE_MIN_MEMBERS) {
    const reasons = members
      .filter((member) => member.status === "missing")
      .map((member) => `${member.title}（${member.reason}）`)
      .join("、");
    throw new BundleError(`束にできる記事が2本未満です。${reasons ? `含められなかった記事: ${reasons}` : ""}`.slice(0, 480));
  }
  // 一覧は依頼された順に揃える
  members.sort((a, b) => memberIds.indexOf(a.articleId) - memberIds.indexOf(b.articleId));

  // 3. 統合(Codex 1回。全記事が出典に現れなければ1回だけ再実行し、それでも欠けたら機械的に足す)
  let synthesis: BundleSynthesis | undefined;
  let uncovered: number[] = [];
  let lastError: unknown;
  for (const attempt of [1, 2]) {
    const prompt = buildSynthesisPrompt(sources, { title: input.title, missingNumbers: attempt === 2 ? uncovered : undefined });
    const { result } = await deps.runPrompt({ prompt, jobDir, logLabel: `synthesis-${attempt}` });
    try {
      const parsed = parseSynthesis(result, sources.length);
      synthesis = parsed;
      uncovered = findUncoveredSources(parsed, sources.length);
      if (uncovered.length === 0) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!synthesis) {
    throw new Error(`bundle synthesis failed twice: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  synthesis = appendUncoveredSources(synthesis, sources, findUncoveredSources(synthesis, sources.length));

  const title = (input.title?.trim() || synthesis.title).slice(0, 120);
  const body = buildBundleMarkdown(synthesis, sources, members);
  await writeFile(path.join(jobDir, "body.md"), `${body}\n`, "utf8");
  await writeFile(path.join(jobDir, "synthesis.json"), `${JSON.stringify({ title, synthesis, members }, null, 2)}\n`, "utf8");

  // 音声(任意)。失敗しても束そのものは作る
  let audio: DigestAudio | undefined;
  let audioError: string | undefined;
  if (input.audio) {
    const narration = usableNarration(synthesis.narration);
    if (!narration) {
      audioError = "読み上げ原稿が規定の長さに収まりませんでした";
    } else {
      try {
        audio = await deps.synthesizeAudio(jobDir, narration);
      } catch (error) {
        audioError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      }
    }
  }

  // 4. 登録(束の疑似URLで、通常の記事と同じ仕組みに載せる)
  await deps.store.register({ url: identity.canonicalUrl, title, headline: synthesis.tldr[0] });
  await deps.store.saveSource(identity.canonicalUrl, body, title);
  await deps.store.saveTldr(identity.canonicalUrl, synthesis.tldr.map((line) => `- ${line}`).join("\n"));
  await deps.store.saveMembers(identity.canonicalUrl, members);
  if (audio) {
    try {
      await deps.store.saveAudio(identity.canonicalUrl, audio);
    } catch (error) {
      audioError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      audio = undefined;
    }
  }

  const missing = members.filter((member) => member.status === "missing").length;
  deps.log(`bundle ${identity.articleId}: included=${sources.length} missing=${missing} digestsCreated=${digestsCreated} audio=${Boolean(audio)}`);
  return {
    articleId: identity.articleId,
    url: identity.canonicalUrl,
    title,
    body,
    included: sources.length,
    missing,
    audio: Boolean(audio),
    ...(audioError ? { audioError } : {}),
    digestsCreated
  };
}
