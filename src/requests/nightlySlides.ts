import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { listInboxCandidates, type InboxCandidate } from "../shared/firebaseArticleStore.js";
import {
  defaultUrlRequestDeps,
  handleUrlRequest,
  runInRequestQueue,
  type UrlGenerationRequest
} from "./generationRequestWatcher.js";

/**
 * 夜間の自動生成。その日に登録されて受信箱に残っている記事(何も作っていない記事)のスライドを、
 * 夜の時間帯(既定 0〜5 時、日本時間)に作る。条件は brain Vault の catchup-platform P003。
 *
 * - 対象: 実行した夜の前日(0〜24 時、日本時間)に登録され、3 行要約が付いている Web / YouTube の記事。
 *   本文が取れなかった記事・3 行要約がまだの記事は外す。削除した記事・1日のまとめも外す。
 * - 一晩に NIGHTLY_SLIDES_MAX 本まで(既定 5)。失敗した記事もその夜の本数に数え、同じ夜には繰り返さない。
 * - 作るのはスライドだけ。Viewer からの依頼と同じ順番待ちに並べ、同時には動かさない。
 * - スライドを作った記事は、ふだんと同じく受信箱から記事一覧へ移る。印は付けない。
 */
const TARGET_KINDS = new Set(["web", "youtube"]);
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日本時間の日付(YYYY-MM-DD)。 */
export function jstDate(date: Date): string {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function jstHour(date: Date): number {
  return new Date(date.getTime() + JST_OFFSET_MS).getUTCHours();
}

/** 前日(日本時間)の日付。 */
export function previousJstDate(date: Date): string {
  return jstDate(new Date(date.getTime() - 24 * 60 * 60 * 1000));
}

/** いまが夜の時間帯(開始時 ≦ 時 < 終了時、日本時間)か。 */
export function isInNightWindow(now: Date, startHour: number, endHour: number): boolean {
  const hour = jstHour(now);
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

/**
 * 夜の時間帯が始まった日(日本時間)。時間帯が日をまたぐ場合(例: 22〜5 時)、0 時を過ぎても前日の夜として扱う。
 * 「その日に登録された記事」は、この夜の前の 1 日分。
 */
export function nightKey(now: Date, startHour: number, endHour: number): string {
  if (startHour >= endHour && jstHour(now) < endHour) return previousJstDate(now);
  return jstDate(now);
}

export function targetRegistrationDate(now: Date, startHour: number, endHour: number): string {
  const key = nightKey(now, startHour, endHour);
  // 0 時始まりの夜は、その前日に登録された記事が対象。日をまたぐ夜(22 時始まりなど)は、始まった日の記事が対象。
  if (startHour < endHour) return previousJstDate(new Date(`${key}T12:00:00+09:00`));
  return key;
}

export function registeredJstDate(registeredAt: string): string {
  const time = Date.parse(registeredAt);
  return Number.isFinite(time) ? jstDate(new Date(time)) : "";
}

/** 対象の記事を、登録の古い順に選ぶ。 */
export function selectNightlyTargets(
  candidates: InboxCandidate[],
  options: { date: string; exclude: Set<string>; max: number }
): InboxCandidate[] {
  return candidates
    .filter(
      (article) =>
        !article.deleted &&
        TARGET_KINDS.has(article.sourceKind) &&
        article.registeredFrom !== "daily-digest" &&
        !article.hasArtifact &&
        article.hasTldr &&
        article.summaryStatus === "done" &&
        registeredJstDate(article.registeredAt) === options.date &&
        !options.exclude.has(article.articleId)
    )
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt))
    .slice(0, Math.max(0, options.max));
}

/** その夜に試した記事の記録(.runtime/nightly-slides.json)。再起動しても同じ夜に作り直さないため。 */
export type NightlyRecord = { night: string; attempted: Array<{ articleId: string; result: "done" | "failed"; at: string }> };

export type NightlySlidesDeps = {
  now: () => Date;
  max: number;
  startHour: number;
  endHour: number;
  list: () => Promise<InboxCandidate[]>;
  generate: (article: InboxCandidate) => Promise<void>;
  record: { read: () => Promise<NightlyRecord | null>; write: (record: NightlyRecord) => Promise<void> };
  log: (message: string) => void;
};

const RECORD_PATH = path.join(".runtime", "nightly-slides.json");

export function defaultNightlySlidesDeps(): NightlySlidesDeps {
  return {
    now: () => new Date(),
    max: config.nightlySlides.max,
    startHour: config.nightlySlides.startHourJst,
    endHour: config.nightlySlides.endHourJst,
    list: listInboxCandidates,
    generate: async (article) => {
      const request: UrlGenerationRequest = {
        kind: "url",
        ownerUid: "nightly",
        urls: [article.canonicalUrl],
        slides: true,
        manga: false,
        video: false,
        status: "processing",
        createdAt: new Date().toISOString(),
        trigger: { provider: "web" }
      };
      let failure = "";
      await runInRequestQueue(() =>
        handleUrlRequest(
          request,
          async (patch) => {
            // 本文が取れなかったときは、依頼の結果として failed が返る(スライドは「対応待ち」になる)
            if (patch.status === "failed") failure = String(patch.statusMessage || patch.error || "failed");
          },
          defaultUrlRequestDeps(),
          (message) => console.log(`[nightly-slides] ${article.articleId}: ${message}`)
        )
      );
      if (failure) throw new Error(failure);
    },
    record: {
      read: async () => {
        try {
          return JSON.parse(await readFile(RECORD_PATH, "utf8")) as NightlyRecord;
        } catch {
          return null;
        }
      },
      write: async (record) => {
        await mkdir(path.dirname(RECORD_PATH), { recursive: true });
        await writeFile(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      }
    },
    log: (message) => console.log(`[nightly-slides] ${message}`)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type NightlyTickResult = "outside-window" | "busy" | { night: string; done: number; failed: number; remaining: number };

let running = false;

/** 1 回分の確認。時間帯の外・前回がまだ動いているときは何もしない。時間帯が終われば新しく始めない。 */
export async function nightlySlidesTick(deps: NightlySlidesDeps = defaultNightlySlidesDeps()): Promise<NightlyTickResult> {
  if (!isInNightWindow(deps.now(), deps.startHour, deps.endHour)) return "outside-window";
  if (running) return "busy";
  running = true;
  try {
    const night = nightKey(deps.now(), deps.startHour, deps.endHour);
    const date = targetRegistrationDate(deps.now(), deps.startHour, deps.endHour);
    const stored = await deps.record.read();
    const record: NightlyRecord = stored && stored.night === night ? stored : { night, attempted: [] };
    let done = 0;
    let failed = 0;
    const targets = selectNightlyTargets(await deps.list(), {
      date,
      exclude: new Set(record.attempted.map((item) => item.articleId)),
      max: deps.max - record.attempted.length
    });
    for (const article of targets) {
      if (!isInNightWindow(deps.now(), deps.startHour, deps.endHour)) break;
      let result: "done" | "failed" = "done";
      try {
        deps.log(`${article.articleId}: slides (${record.attempted.length + 1}/${deps.max})`);
        await deps.generate(article);
        done += 1;
      } catch (error) {
        result = "failed";
        failed += 1;
        deps.log(`${article.articleId}: failed: ${errorMessage(error).slice(0, 300)}`);
      }
      record.attempted.push({ articleId: article.articleId, result, at: deps.now().toISOString() });
      await deps.record.write(record);
    }
    return { night, done, failed, remaining: Math.max(0, deps.max - record.attempted.length) };
  } finally {
    running = false;
  }
}

const CHECK_INTERVAL_MS = 10 * 60_000;

/** 常駐プロセスから呼ぶ。NIGHTLY_SLIDES_ENABLED が true のときだけ、10 分ごとに確認する。 */
export function startNightlySlides(logger: Pick<Console, "log" | "error"> = console): boolean {
  if (!config.nightlySlides.enabled) return false;
  const tick = () => {
    nightlySlidesTick()
      .then((result) => {
        if (typeof result === "object" && result.done + result.failed > 0) logger.log(`[nightly-slides] ${JSON.stringify(result)}`);
      })
      .catch((error) => logger.error(`[nightly-slides] tick failed: ${errorMessage(error)}`));
  };
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
  const { startHourJst, endHourJst, max } = config.nightlySlides;
  logger.log(`[nightly-slides] slides for today's inbox articles at ${startHourJst}:00-${endHourJst}:00 JST (up to ${max} per night)`);
  return true;
}
