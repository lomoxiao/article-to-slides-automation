import { z } from "zod";
import { getDb } from "../shared/firebaseAdmin.js";
import { createArticleIdentity, createTextArticleIdentity } from "../shared/identity.js";
import {
  registerArticle,
  upsertArticleSource,
  upsertMangaArtifact,
  upsertSlideArtifact,
  upsertVideoArtifact
} from "../shared/firebaseArticleStore.js";
import { runUrlToGasSlidesWorkflow } from "../workflows/urlToGasSlides.js";
import { processSlideJob } from "../domains/slides/slideJobProcessor.js";
import { enqueueMangaGeneration } from "../domains/manga/mangaGenerationQueue.js";
import { enqueueVideoGeneration } from "../domains/video/videoGenerationQueue.js";
import { ingestArticle, type IngestResult } from "../domains/ingest/ingestArticle.js";
import { DEFAULT_MANGA_PAGES } from "../utils/parseMangaSlackArgs.js";
import type { MangaTreatment } from "../types/manga.js";
import {
  ensureSlidesRuntimeReady,
  isSlidesRuntimeUnavailableError,
  PLAYWRIGHT_PUBLIC_STATUS_MESSAGE
} from "../domains/slides/playwrightPreflight.js";
import { SOURCE_UNAVAILABLE_CODE, isSourceUnavailableError } from "../shared/sourceErrors.js";
import { isPublicHttpUrl, sanitizeArticleUrl } from "../utils/url.js";

// Viewer からの生成依頼(依頼キュー)。テキスト投入と URL 投入を同じ入口で受ける。
// スライド・漫画・動画の3つを振り分けるため、特定の成果物のフォルダではなく src/requests/ に置く。
const REQUESTS_PATH = "/generationRequests";
const MAX_PROCESSED_IDS = 500;
const MAX_REQUEST_URLS = 3;

// viewerがRules(create-only, ownerUid=auth.uid, status=queued)の下で書く形。
// admin側は防御的に再検証する(Rulesを信用しつつ、path追加やRules事故に備える)。
const commonRequestFields = {
  ownerUid: z.string().min(1),
  slides: z.boolean().optional().default(false),
  manga: z.boolean().optional().default(false),
  video: z.boolean().optional().default(false),
  audience: z.string().max(500).optional(),
  focus: z.string().max(500).optional(),
  mangaOptions: z
    .object({
      artStyle: z.string().regex(/^[A-G]$/),
      treatment: z.string().regex(/^[A-C]$/),
      genre: z.string().max(100).optional()
    })
    .optional(),
  status: z.string(),
  createdAt: z.string().max(64),
  trigger: z.object({ provider: z.literal("web") })
};

const textRequestSchema = z.object({
  ...commonRequestFields,
  kind: z.literal("text"),
  title: z.string().max(200).optional(),
  text: z.string().min(1).max(100_000)
});

const urlRequestSchema = z.object({
  ...commonRequestFields,
  kind: z.literal("url"),
  urls: z.array(z.string().min(1).max(2048)).min(1).max(MAX_REQUEST_URLS)
});

// 依頼の種類は kind で見分ける。束(bundle)などを後から足せる形にしてある。
export const generationRequestSchema = z
  .discriminatedUnion("kind", [textRequestSchema, urlRequestSchema])
  .superRefine((request, ctx) => {
    if (!request.slides && !request.manga && !request.video) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At least one of slides, manga, or video must be true" });
    }
    if (request.manga !== Boolean(request.mangaOptions)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mangaOptions"], message: "mangaOptions must be present exactly when manga is true" });
    }
    if (request.kind === "url") {
      request.urls.forEach((url, index) => {
        // 自分のPCや家庭内ネットワークを指すURLは、依頼の時点で分かりやすく拒否する
        if (!isPublicHttpUrl(sanitizeArticleUrl(url))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["urls", index], message: "url must be a public http(s) URL" });
        }
      });
      if (request.urls.length > 1 && (request.manga || request.video)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["urls"], message: "manga and video accept exactly one url" });
      }
    }
  });

type GenerationRequest = z.infer<typeof generationRequestSchema>;
type TextGenerationRequest = Extract<GenerationRequest, { kind: "text" }>;
export type UrlGenerationRequest = Extract<GenerationRequest, { kind: "url" }>;

type Logger = Pick<Console, "log" | "warn" | "error">;
type RequestUpdate = (patch: Record<string, unknown>) => Promise<void>;

// socketModeClientと同じbounded-set dedupe。child_addedの再送・再接続に備える。
const processedRequestIds = new Set<string>();

// mangaGenerationQueueと同じ直列Promiseチェーン。Codex実行は重いため1件ずつ処理する。
let queueTail: Promise<void> = Promise.resolve();

export function startGenerationRequestWatcher(logger: Logger = console): void {
  const db = getDb();

  void recoverOrphanedRequests(logger);

  db.ref(REQUESTS_PATH)
    .orderByChild("status")
    .equalTo("queued")
    .on(
      "child_added",
      (snapshot) => {
        const requestId = snapshot.key;
        if (!requestId || processedRequestIds.has(requestId)) return;
        rememberProcessedId(requestId);
        queueTail = queueTail.then(() => handleRequest(requestId, logger)).catch((error) => {
          logger.error(`[generation-request] queue error: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
      (error: Error) => {
        logger.error(`[generation-request] listener error: ${error.message}`);
      }
    );

  logger.log(`[generation-request] watching ${REQUESTS_PATH} (status=queued)`);
}

/**
 * 再起動時の残留processingをfailedへ落とす。Codex実行途中でdaemonが死んだ場合の
 * 二重生成を避けるため、自動再実行はしない(必要ならviewerから再投稿)。
 */
async function recoverOrphanedRequests(logger: Logger): Promise<void> {
  try {
    const snapshot = await getDb()
      .ref(REQUESTS_PATH)
      .orderByChild("status")
      .equalTo("processing")
      .get();
    if (!snapshot.exists()) return;
    const updates: Record<string, unknown> = {};
    snapshot.forEach((child) => {
      updates[`${child.key}/status`] = "failed";
      updates[`${child.key}/error`] = "daemon restart";
    });
    await getDb().ref(REQUESTS_PATH).update(updates);
    logger.warn(`[generation-request] marked ${Object.keys(updates).length / 2} orphaned request(s) as failed`);
  } catch (error) {
    logger.warn(
      `[generation-request] orphan recovery failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function handleRequest(requestId: string, logger: Logger): Promise<void> {
  const requestRef = getDb().ref(`${REQUESTS_PATH}/${requestId}`);

  // 多重起動・child_added再送に備え、queued→processingへのクレームをtransactionで排他する
  const claim = await requestRef.child("status").transaction((current) =>
    current === "queued" ? "processing" : undefined
  );
  if (!claim.committed) {
    logger.log(`[generation-request] ${requestId}: already claimed, skipping`);
    return;
  }

  const snapshot = await requestRef.get();
  const parsed = generationRequestSchema.safeParse(snapshot.val());
  if (!parsed.success) {
    logger.warn(`[generation-request] ${requestId}: invalid payload: ${parsed.error.message}`);
    await requestRef.update({ status: "failed", error: "invalid request payload" });
    return;
  }
  const request: GenerationRequest = parsed.data;
  const update: RequestUpdate = (patch) => requestRef.update(patch);

  try {
    if (request.kind === "url") {
      await handleUrlRequest(request, update, defaultUrlRequestDeps(), (message) =>
        logger.log(`[generation-request] ${requestId}: ${message}`)
      );
    } else {
      await handleTextRequest(requestId, request, update, logger);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[generation-request] ${requestId}: failed: ${message}`);
    await requestRef.update(generationRequestFailure(error)).catch(() => {});
  }
}

async function handleTextRequest(
  requestId: string,
  request: TextGenerationRequest,
  update: RequestUpdate,
  logger: Logger
): Promise<void> {
  const identity = createTextArticleIdentity(request.text);
  const title = request.title || request.text.trim().split("\n")[0].slice(0, 80);

  await registerArticle({
    url: identity.canonicalUrl,
    title,
    registeredFrom: "viewer-text"
  });
  await upsertArticleSource(identity.canonicalUrl, request.text, {
    version: 2,
    method: "provided_text"
  });

  if (request.video) {
    await enqueueVideoGeneration({
      url: identity.canonicalUrl,
      sourceText: request.text,
      sourceTitle: title,
      audience: request.audience,
      focus: request.focus,
      requestedBy: `viewer:${request.ownerUid}`
    });
  }

  if (request.manga && request.mangaOptions) {
    enqueueMangaGeneration({
      url: identity.canonicalUrl,
      sourceText: request.text,
      sourceTitle: title,
      pages: DEFAULT_MANGA_PAGES,
      artStyle: request.mangaOptions.artStyle,
      treatment: request.mangaOptions.treatment as MangaTreatment,
      genre: request.mangaOptions.genre,
      audience: request.audience,
      focus: request.focus,
      requestedBy: `viewer:${request.ownerUid}`
    });
  }

  if (request.slides) {
    await ensureSlidesRuntimeReady();
    logger.log(`[generation-request] ${requestId}: slides job for ${identity.articleId}`);
    const job = await runUrlToGasSlidesWorkflow({
      url: identity.canonicalUrl,
      sourceText: request.text,
      sourceTitle: title,
      audience: request.audience,
      focus: request.focus
    });
    const result = await processSlideJob(job.id);
    if (!result.ok) {
      throw new Error("AUTO_RUN_CODEX is disabled; slideData.json was not generated automatically.");
    }
  }

  await update({ status: "done", articleId: identity.articleId });
  logger.log(`[generation-request] ${requestId}: done (${identity.articleId})`);
}

export type UrlRequestDeps = {
  register: (url: string) => Promise<unknown>;
  ingest: (url: string) => Promise<Pick<IngestResult, "title" | "quality" | "text" | "reused">>;
  /** 依頼された成果物を「本文が取れていません」の対応待ちにする。 */
  markSourceUnavailable: (url: string, request: UrlGenerationRequest, message: string) => Promise<void>;
  enqueueVideo: (input: { url: string; audience?: string; focus?: string; requestedBy: string }) => Promise<unknown>;
  enqueueManga: (input: {
    url: string;
    artStyle: string;
    treatment: string;
    genre?: string;
    audience?: string;
    focus?: string;
    requestedBy: string;
  }) => void;
  runSlides: (input: { urls: string[]; sourceTitle?: string; audience?: string; focus?: string }) => Promise<void>;
};

function defaultUrlRequestDeps(): UrlRequestDeps {
  return {
    register: (url) => registerArticle({ url, registeredFrom: "viewer-url" }),
    ingest: (url) => ingestArticle(url),
    markSourceUnavailable: async (url, request, message) => {
      if (request.slides) {
        await upsertSlideArtifact({
          originalUrl: url,
          slidesStatus: "action_required",
          stage: "slides_generation",
          statusMessage: message,
          slidesUrl: ""
        });
      }
      if (request.manga) {
        await upsertMangaArtifact({ articleUrl: url, deckUrl: "", status: "action_required", stage: "preparing", statusMessage: message });
      }
      if (request.video) {
        await upsertVideoArtifact({ articleUrl: url, videoUrl: "", status: "action_required", stage: "video_queued", statusMessage: message });
      }
    },
    enqueueVideo: (input) => enqueueVideoGeneration(input),
    enqueueManga: (input) =>
      enqueueMangaGeneration({
        url: input.url,
        pages: DEFAULT_MANGA_PAGES,
        artStyle: input.artStyle,
        treatment: input.treatment as MangaTreatment,
        genre: input.genre,
        audience: input.audience,
        focus: input.focus,
        requestedBy: input.requestedBy
      }),
    runSlides: async (input) => {
      await ensureSlidesRuntimeReady();
      const job = await runUrlToGasSlidesWorkflow(
        input.urls.length > 1
          ? { urls: input.urls, audience: input.audience, focus: input.focus }
          : { url: input.urls[0], sourceTitle: input.sourceTitle, audience: input.audience, focus: input.focus }
      );
      const result = await processSlideJob(job.id);
      if (!result.ok) {
        throw new Error("AUTO_RUN_CODEX is disabled; slideData.json was not generated automatically.");
      }
    }
  };
}

/**
 * URL の依頼を処理する。先に本文を取り込み、取れなければ何も生成せずに止める。
 * 取り込めたら、依頼に取り込み結果(全文/一部・文字数)を書いてから各生成へ進む。
 * 生成側も取り込み工程を通るため、ここで保存した本文が再利用され、外部サイトへの取得は1回で済む。
 */
export async function handleUrlRequest(
  request: UrlGenerationRequest,
  update: RequestUpdate,
  deps: UrlRequestDeps,
  log: (message: string) => void = () => {}
): Promise<void> {
  const urls = request.urls.map(sanitizeArticleUrl);
  const primaryUrl = urls[0];
  const articleId = createArticleIdentity(primaryUrl).articleId;
  const requestedBy = `viewer:${request.ownerUid}`;
  let sourceTitle: string | undefined;

  if (urls.length === 1) {
    await deps.register(primaryUrl);
    try {
      const source = await deps.ingest(primaryUrl);
      sourceTitle = source.title;
      await update({
        articleId,
        ingest: {
          verdict: source.quality?.verdict === "partial" ? "partial" : "full",
          chars: source.quality?.chars ?? source.text.length,
          reused: source.reused
        }
      });
    } catch (error) {
      if (!isSourceUnavailableError(error)) throw error;
      log(`source unavailable: ${error.reason}`);
      await deps.markSourceUnavailable(primaryUrl, request, error.message).catch(() => {});
      await update({
        status: "failed",
        articleId,
        errorCode: SOURCE_UNAVAILABLE_CODE,
        statusMessage: error.message,
        error: error.message.slice(0, 500)
      });
      return;
    }
  }

  if (request.video) {
    await deps.enqueueVideo({ url: primaryUrl, audience: request.audience, focus: request.focus, requestedBy });
  }
  if (request.manga && request.mangaOptions) {
    deps.enqueueManga({
      url: primaryUrl,
      artStyle: request.mangaOptions.artStyle,
      treatment: request.mangaOptions.treatment,
      genre: request.mangaOptions.genre,
      audience: request.audience,
      focus: request.focus,
      requestedBy
    });
  }
  if (request.slides) {
    log(`slides job for ${articleId}`);
    await deps.runSlides({ urls, sourceTitle, audience: request.audience, focus: request.focus });
  }

  await update({ status: "done", articleId });
  log(`done (${articleId})`);
}

export function generationRequestFailure(error: unknown): Record<string, string> {
  if (isSlidesRuntimeUnavailableError(error)) {
    return {
      status: "failed",
      errorCode: "PLAYWRIGHT_CHROMIUM_UNAVAILABLE",
      statusMessage: PLAYWRIGHT_PUBLIC_STATUS_MESSAGE,
      error: "Playwright Chromium unavailable"
    };
  }
  // 複数URLのスライドなど、生成の途中で本文が取れないと分かった場合
  if (isSourceUnavailableError(error)) {
    return {
      status: "failed",
      errorCode: SOURCE_UNAVAILABLE_CODE,
      statusMessage: error.message,
      error: error.message.slice(0, 500)
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: "failed", error: message.slice(0, 500) };
}

function rememberProcessedId(requestId: string): void {
  processedRequestIds.add(requestId);
  if (processedRequestIds.size > MAX_PROCESSED_IDS) {
    const first = processedRequestIds.values().next().value;
    if (first) processedRequestIds.delete(first);
  }
}
