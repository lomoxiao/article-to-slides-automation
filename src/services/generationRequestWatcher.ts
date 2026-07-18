import { z } from "zod";
import { getDb } from "./firebaseAdmin.js";
import { createTextArticleIdentity } from "./identity.js";
import { registerArticle, upsertArticleSource } from "./firebaseArticleStore.js";
import { runUrlToGasSlidesWorkflow } from "../workflows/urlToGasSlides.js";
import { processSlideJob } from "./slideJobProcessor.js";
import { enqueueMangaGeneration } from "./mangaGenerationQueue.js";
import { DEFAULT_MANGA_PAGES } from "../utils/parseMangaSlackArgs.js";
import type { MangaTreatment } from "../types/manga.js";

const REQUESTS_PATH = "/generationRequests";
const MAX_PROCESSED_IDS = 500;

// viewerがRules(create-only, ownerUid=auth.uid, status=queued)の下で書く形。
// admin側は防御的に再検証する(Rulesを信用しつつ、path追加やRules事故に備える)。
const generationRequestSchema = z.object({
  ownerUid: z.string().min(1),
  kind: z.literal("text"),
  title: z.string().max(200).optional(),
  text: z.string().min(1).max(100_000),
  slides: z.literal(true),
  manga: z.boolean().optional(),
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
});

type GenerationRequest = z.infer<typeof generationRequestSchema>;

// socketModeClientと同じbounded-set dedupe。child_addedの再送・再接続に備える。
const processedRequestIds = new Set<string>();

// mangaGenerationQueueと同じ直列Promiseチェーン。Codex実行は重いため1件ずつ処理する。
let queueTail: Promise<void> = Promise.resolve();

export function startGenerationRequestWatcher(logger: Pick<Console, "log" | "warn" | "error"> = console): void {
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
async function recoverOrphanedRequests(logger: Pick<Console, "log" | "warn" | "error">): Promise<void> {
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

async function handleRequest(requestId: string, logger: Pick<Console, "log" | "warn" | "error">): Promise<void> {
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

  try {
    const identity = createTextArticleIdentity(request.text);
    const title = request.title || request.text.trim().split("\n")[0].slice(0, 80);

    await registerArticle({
      url: identity.canonicalUrl,
      title,
      registeredFrom: "viewer-text"
    });
    await upsertArticleSource(identity.canonicalUrl, request.text);

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

    if (request.manga && request.mangaOptions) {
      // マンガは既存の直列キューへ委譲(完了を待たない)。requestのstatusはスライドの結果を表す
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

    await requestRef.update({ status: "done", articleId: identity.articleId });
    logger.log(`[generation-request] ${requestId}: done (${identity.articleId})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[generation-request] ${requestId}: failed: ${message}`);
    await requestRef
      .update({ status: "failed", error: message.slice(0, 500) })
      .catch(() => {});
  }
}

function rememberProcessedId(requestId: string): void {
  processedRequestIds.add(requestId);
  if (processedRequestIds.size > MAX_PROCESSED_IDS) {
    const first = processedRequestIds.values().next().value;
    if (first) processedRequestIds.delete(first);
  }
}
