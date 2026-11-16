import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import {
  pruneArticleAudio,
  registerArticle,
  upsertArticleSource,
  upsertArticleTldr
} from "../../shared/firebaseArticleStore.js";
import { createTextArticleIdentity } from "../../shared/identity.js";
import { postSlackText } from "../../shared/slackNotifier.js";
import { buildReaderUrl } from "../reader/instapaperDelivery.js";
import { saveArticleAudioFile, synthesizeDigestAudio, type DigestAudio } from "./digestAudio.js";
import { countDigestArticles, parseDigestInput, type DigestInput } from "./digestInput.js";
import { buildDigestMarkdown, buildDigestTitle } from "./digestMarkdown.js";
import { generateDigestScript, parseDigestScript, type DigestScript } from "./digestScript.js";

/** 音声データの保持日数。過ぎたものは次回のまとめ作成時に削除する。 */
export const DIGEST_AUDIO_RETENTION_DAYS = 14;
const WATCH_INTERVAL_MS = 30 * 60 * 1000;

export type DigestStage = "input" | "script" | "register";

export type DigestRunResult =
  | { status: "done"; date: string; articleId: string; articles: number; audio: boolean; audioError?: string }
  | { status: "empty"; date: string }
  | { status: "no_input"; date: string }
  | { status: "skipped"; date: string; reason: "already_done" | "previously_failed" }
  | { status: "failed"; date: string; stage: DigestStage; error: string };

export type DigestDeps = {
  sourceDir: string;
  jobsRoot: string;
  generateScript: (input: { date: string; body: string; jobDir: string }) => Promise<DigestScript>;
  synthesizeAudio: (jobDir: string, narration: string) => Promise<DigestAudio>;
  store: {
    register: (input: { url: string; title: string; headline: string }) => Promise<{ articleId: string }>;
    saveSource: (url: string, markdown: string) => Promise<void>;
    saveTldr: (url: string, tldr: string) => Promise<void>;
    saveAudio: (url: string, audio: DigestAudio) => Promise<void>;
    pruneAudio: () => Promise<number>;
  };
  notify: (text: string) => Promise<void>;
  readerUrl: (articleUrl: string) => string;
  log: (message: string) => void;
};

export function defaultDigestDeps(): DigestDeps {
  return {
    sourceDir: config.digest.sourceDir,
    jobsRoot: path.join("jobs", "digest"),
    generateScript: (input) => generateDigestScript(input),
    synthesizeAudio: synthesizeDigestAudio,
    store: {
      register: (input) => registerArticle({ ...input, registeredFrom: "daily-digest" }),
      saveSource: (url, markdown) => upsertArticleSource(url, markdown, { version: 2, method: "daily_digest" }),
      saveTldr: upsertArticleTldr,
      saveAudio: saveArticleAudioFile,
      pruneAudio: () => pruneArticleAudio(DIGEST_AUDIO_RETENTION_DAYS)
    },
    notify: (text) => postSlackText({ text }),
    readerUrl: (articleUrl) => buildReaderUrl(config.instapaper.readerBaseUrl, articleUrl),
    log: (message) => console.log(`[daily-digest] ${message}`)
  };
}

/** 日付ごとに固定の記事ID(疑似URL)。同じ日は同じ記事に上書きされ、重複登録されない。 */
export function digestArticleUrl(date: string): string {
  return createTextArticleIdentity(`daily-digest:${date}`).canonicalUrl;
}

export function todayJst(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function hourJst(now: Date): number {
  return new Date(now.getTime() + 9 * 3_600_000).getUTCHours();
}

async function writeMarker(jobDir: string, name: string, value: unknown): Promise<void> {
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 通知の失敗でまとめ自体を失敗にしない。 */
async function safeNotify(deps: DigestDeps, text: string): Promise<void> {
  try {
    await deps.notify(text);
  } catch (error) {
    deps.log(`notification failed: ${errorMessage(error)}`);
  }
}

const STAGE_LABEL: Record<DigestStage, string> = {
  input: "材料の検証",
  script: "要約と読み上げ原稿の作成",
  register: "Viewerへの登録"
};

/**
 * 指定日の「今日のまとめ」を作る。各工程の成果は jobs/digest/<date>/ に残し、再実行時に再利用する。
 * - 成功: done.json を置く。同じ日の再実行は(force でない限り)何もしない。
 * - 失敗: failed.json を置く。失敗の繰り返しで固定枠を消費しないよう、自動では再試行しない。
 * - 音声だけ作れなかった場合は、本文と3行要約を登録したうえで通知に理由を添える(全体は失敗にしない)。
 */
export async function runDailyDigest(
  date: string,
  options: { force?: boolean } = {},
  deps: DigestDeps = defaultDigestDeps()
): Promise<DigestRunResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${date}`);
  const jobDir = path.join(deps.jobsRoot, date);
  if (!options.force) {
    if (existsSync(path.join(jobDir, "done.json"))) return { status: "skipped", date, reason: "already_done" };
    if (existsSync(path.join(jobDir, "failed.json"))) return { status: "skipped", date, reason: "previously_failed" };
  }

  const inputPath = path.join(deps.sourceDir, `${date}.json`);
  if (!existsSync(inputPath)) return { status: "no_input", date };

  let stage: DigestStage = "input";
  try {
    await mkdir(jobDir, { recursive: true });
    const raw = (await readFile(inputPath, "utf8")).replace(/^\uFEFF/, "");
    const input: DigestInput = parseDigestInput(JSON.parse(raw));
    if (input.date !== date) throw new Error(`digest input date mismatch: file=${date} content=${input.date}`);
    await writeFile(path.join(jobDir, "input.json"), `${JSON.stringify(input, null, 2)}\n`, "utf8");

    if (input.chapters.length === 0) {
      await writeMarker(jobDir, "done.json", { status: "empty", finishedAt: new Date().toISOString() });
      await safeNotify(deps, `今日のまとめ（${date}）: 本日は該当する記事がありませんでした。`);
      return { status: "empty", date };
    }

    const body = buildDigestMarkdown(input);
    await writeFile(path.join(jobDir, "body.md"), `${body}\n`, "utf8");

    stage = "script";
    const scriptPath = path.join(jobDir, "codex-output.json");
    let script: DigestScript | undefined;
    if (existsSync(scriptPath)) {
      // 前回の成果を再利用する(壊れていれば作り直す)
      try {
        script = parseDigestScript(await readFile(scriptPath, "utf8"));
      } catch {
        script = undefined;
      }
    }
    if (!script) {
      script = await deps.generateScript({ date, body, jobDir });
      await writeFile(scriptPath, `${JSON.stringify(script, null, 2)}\n`, "utf8");
    }

    // 音声は失敗しても全体を止めない
    let audio: DigestAudio | undefined;
    let audioError: string | undefined;
    try {
      audio = await deps.synthesizeAudio(jobDir, script.narration);
    } catch (error) {
      audioError = errorMessage(error).slice(0, 300);
      deps.log(`audio skipped: ${audioError}`);
    }

    stage = "register";
    const url = digestArticleUrl(date);
    const { articleId } = await deps.store.register({
      url,
      title: buildDigestTitle(date),
      headline: script.tldr[0]
    });
    await deps.store.saveSource(url, body);
    await deps.store.saveTldr(url, script.tldr.map((line) => `- ${line}`).join("\n"));
    if (audio) {
      try {
        await deps.store.saveAudio(url, audio);
      } catch (error) {
        audioError = errorMessage(error).slice(0, 300);
        audio = undefined;
        deps.log(`audio upload skipped: ${audioError}`);
      }
    }
    await deps.store.pruneAudio().catch((error) => deps.log(`audio prune failed: ${errorMessage(error)}`));

    const articles = countDigestArticles(input);
    await writeMarker(jobDir, "done.json", {
      status: "done",
      articleId,
      articles,
      audio: Boolean(audio),
      ...(audioError ? { audioError } : {}),
      finishedAt: new Date().toISOString()
    });

    const chapterSummary = input.chapters.map((chapter) => `${chapter.title} ${chapter.articles.length}件`).join("・");
    await safeNotify(
      deps,
      [
        `今日のまとめができました（${chapterSummary}）`,
        deps.readerUrl(url),
        ...(audio ? [] : [`音声は作成できませんでした: ${audioError ?? "不明"}`])
      ].join("\n")
    );
    return { status: "done", date, articleId, articles, audio: Boolean(audio), ...(audioError ? { audioError } : {}) };
  } catch (error) {
    const message = errorMessage(error).slice(0, 1000);
    await writeMarker(jobDir, "failed.json", { stage, error: message, failedAt: new Date().toISOString() }).catch(() => {});
    await safeNotify(
      deps,
      `今日のまとめ（${date}）を作成できませんでした。\n工程: ${STAGE_LABEL[stage]}\n${message.slice(0, 300)}\n再実行: npm run digest:run -- --date ${date} --force`
    );
    return { status: "failed", date, stage, error: message };
  }
}

let running = false;

/**
 * 定期確認の1回分。今日(JST)の材料があり未作成なら作る。
 * 指定時刻を過ぎても材料が無ければ、1日1回だけ知らせる。昨日以前の分はさかのぼらない。
 */
export async function digestTick(
  now: Date,
  alertHourJst: number,
  deps: DigestDeps = defaultDigestDeps()
): Promise<DigestRunResult | { status: "busy" } | { status: "alerted"; date: string }> {
  if (running) return { status: "busy" };
  running = true;
  try {
    const date = todayJst(now);
    const result = await runDailyDigest(date, {}, deps);
    if (result.status !== "no_input") return result;

    const jobDir = path.join(deps.jobsRoot, date);
    if (hourJst(now) >= alertHourJst && !existsSync(path.join(jobDir, "alerts.json"))) {
      await writeMarker(jobDir, "alerts.json", { noInputAlertedAt: now.toISOString() });
      await safeNotify(
        deps,
        `今日のまとめ（${date}）の材料がまだ届いていません。news-dashboard の日次ジョブが動いたか確認してください。`
      );
      return { status: "alerted", date };
    }
    return result;
  } finally {
    running = false;
  }
}

/** 常駐プロセスから呼ぶ。DIGEST_ENABLED が true のときだけ、起動時と30分ごとに確認する。 */
export function startDailyDigestWatcher(logger: Pick<Console, "log" | "warn" | "error"> = console): boolean {
  if (!config.digest.enabled) return false;
  if (!config.digest.sourceDir) {
    logger.warn("[daily-digest] DIGEST_ENABLED is true but DIGEST_SOURCE_DIR is not set; watcher not started");
    return false;
  }
  const tick = () => {
    digestTick(new Date(), config.digest.alertHourJst)
      .then((result) => {
        if (result.status !== "no_input" && result.status !== "skipped" && result.status !== "busy") {
          logger.log(`[daily-digest] ${JSON.stringify(result)}`);
        }
      })
      .catch((error) => logger.error(`[daily-digest] tick failed: ${errorMessage(error)}`));
  };
  tick();
  setInterval(tick, WATCH_INTERVAL_MS);
  logger.log(`[daily-digest] watching ${config.digest.sourceDir} (every 30 min)`);
  return true;
}
