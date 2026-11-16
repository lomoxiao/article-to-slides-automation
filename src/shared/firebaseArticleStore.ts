import { z } from "zod";
import { createArticleIdentity, getUrlHost, normalizeSlidesUrl } from "./identity.js";
import { chooseText } from "./textUtils.js";
import { getDb } from "./firebaseAdmin.js";

const MAX_URL_LENGTH = 2048;
const MAX_TEXT_LENGTH = 1000;

const registerArticleInputSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "url is required")
    .max(MAX_URL_LENGTH, "url is too long")
    .refine(
      (value) =>
        /^https?:\/\//i.test(value) || /^text:txt_[0-9a-f]{12}$/.test(value) || /^bundle:bnd_[0-9a-f]{12}$/.test(value),
      "url must start with http:// or https:// (or be a text: / bundle: canonical)"
    ),
  title: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
  headline: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
  registeredFrom: z.string().trim().max(64).optional()
});

export type RegisterArticleInput = z.input<typeof registerArticleInputSchema>;

export type RegisterArticleResult = {
  articleId: string;
  canonicalUrl: string;
  sourceKind: "web" | "youtube" | "text" | "bundle";
  isNew: boolean;
};

type ExistingArticle = {
  originalUrl?: string;
  title?: string;
  source?: { headline?: string };
  registeredFrom?: string;
  deletedAt?: string;
};

/**
 * Viewer で削除した記事には deletedAt / deletedBy が付き、一覧から隠れる。
 * 同じ記事をもう一度登録・生成依頼したときは、利用者が再び見たいということなので、この印を外す。
 * (印が無ければ何も変えない。update に null を渡すとその項目が消える)
 */
export function restoreDeletedPatch(existing: { deletedAt?: unknown } | undefined | null): Record<string, null> {
  return existing?.deletedAt ? { deletedAt: null, deletedBy: null } : {};
}

/** 削除済みの印が付いていれば外す。外した場合は true。 */
export async function restoreDeletedArticle(articleUrl: string): Promise<boolean> {
  const identity = createArticleIdentity(articleUrl);
  const ref = getDb().ref(`/articles/${identity.articleId}`);
  const snapshot = await ref.child("deletedAt").get();
  if (!snapshot.exists()) return false;
  await ref.update(restoreDeletedPatch({ deletedAt: snapshot.val() }));
  return true;
}

/**
 * Current time as a JST (UTC+9) ISO 8601 string with an explicit offset,
 * e.g. "2026-06-21T02:48:28.000+09:00". `Date.prototype.toISOString` always
 * emits UTC ("...Z"); we shift the instant by +9h and swap the suffix so the
 * stored timestamps read as Japan time while staying a valid, sortable ISO
 * string (every record uses the same offset).
 */
function nowJstIso(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace("Z", "+09:00");
}

/**
 * Register (or refresh) an article in Firebase Realtime Database.
 *
 * Writes ONLY the registration-owned fields via a partial update, so existing
 * `slides` / `manga` artefacts written by the automation pipeline are never
 * clobbered (the keys are simply absent from the patch). On re-registration the
 * record is updated in place — no duplicate node is created — and a stronger
 * title/headline only overwrites a weak (empty / host-only) existing value.
 */
export async function registerArticle(rawInput: RegisterArticleInput): Promise<RegisterArticleResult> {
  const input = registerArticleInputSchema.parse(rawInput);
  const identity = createArticleIdentity(input.url);

  const ref = getDb().ref(`/articles/${identity.articleId}`);
  const snapshot = await ref.get();
  const existing: ExistingArticle | undefined = snapshot.exists() ? snapshot.val() : undefined;

  const now = nowJstIso();
  const fallbackTitle = getUrlHost(identity.canonicalUrl) || identity.canonicalUrl;

  const patch: Record<string, unknown> = {
    articleId: identity.articleId,
    canonicalUrl: identity.canonicalUrl,
    originalUrl: existing?.originalUrl || input.url,
    title: chooseText(input.title, existing?.title, fallbackTitle),
    source: {
      kind: identity.sourceKind,
      headline: chooseText(input.headline, existing?.source?.headline, "")
    },
    registeredFrom: existing?.registeredFrom || input.registeredFrom || "shortcut",
    lastRegisteredAt: now,
    updatedAt: now,
    // 削除済みの記事を登録し直した場合は、一覧に戻す
    ...restoreDeletedPatch(existing)
  };
  if (!existing) {
    patch.registeredAt = now;
  }

  await ref.update(patch);

  return {
    articleId: identity.articleId,
    canonicalUrl: identity.canonicalUrl,
    sourceKind: identity.sourceKind,
    isNew: !existing
  };
}

export type ViewerArticleStatus = "pending" | "processing" | "action_required" | "completed" | "failed";

export type ArtifactStage =
  | "preparing"
  | "drive_registration"
  | "source_registration"
  | "deck_generation"
  | "url_retrieval"
  | "slides_generation"
  | "video_queued"
  | "video_planning"
  | "video_tts"
  | "video_captioning"
  | "video_transcribing"
  | "video_rendering"
  | "video_uploading";

export type UpsertSlideArtifactInput = {
  originalUrl?: string;
  canonicalUrl?: string;
  title?: string;
  headline?: string;
  slidesStatus: ViewerArticleStatus;
  stage?: ArtifactStage;
  statusMessage?: string;
  slidesUrl?: string;
  presentationId?: string | null;
  updatedAt?: string;
};

export type UpsertSlideArtifactResult = {
  articleId: string;
  isNew: boolean;
};

type ExistingSlideArticle = {
  originalUrl?: string;
  title?: string;
  source?: { headline?: string };
  slides?: ExistingArtifact;
};

/**
 * Write the slides artifact for an article into Firebase Realtime Database.
 *
 * This is the automation-side counterpart to {@link registerArticle}: it updates
 * ONLY the slides-owned fields via a partial update, so `manga` and the
 * registration-owned fields (registeredAt / registeredFrom / lastRegisteredAt)
 * are never clobbered (they are simply absent from the patch). title / headline
 * are filled via chooseText so a weaker (slide-derived) value never overwrites a
 * stronger existing one. The articleId is recomputed from the URL so the slides
 * land on the same node a Shortcut registration would create.
 */
export async function upsertSlideArtifact(input: UpsertSlideArtifactInput): Promise<UpsertSlideArtifactResult | undefined> {
  const sourceUrl = input.canonicalUrl || input.originalUrl;
  if (!sourceUrl) {
    return undefined;
  }

  const identity = createArticleIdentity(sourceUrl);
  const ref = getDb().ref(`/articles/${identity.articleId}`);
  const snapshot = await ref.get();
  const existing: ExistingSlideArticle | undefined = snapshot.exists() ? snapshot.val() : undefined;

  const fallbackTitle = getUrlHost(identity.canonicalUrl) || identity.canonicalUrl;
  const slidesUrl = normalizeSlidesUrl(input.slidesUrl || existing?.slides?.url || "", input.presentationId);
  const updatedAt = input.updatedAt || nowJstIso();
  const slides = shouldPreserveManualArtifact(existing?.slides)
    ? existing?.slides
    : {
        status: input.slidesStatus,
        ...(input.stage ? { stage: input.stage } : {}),
        ...(input.statusMessage ? { statusMessage: input.statusMessage } : {}),
        url: slidesUrl,
        origin: "automation",
        locked: false,
        updatedAt
      };

  const patch: Record<string, unknown> = {
    articleId: identity.articleId,
    canonicalUrl: identity.canonicalUrl,
    originalUrl: existing?.originalUrl || input.originalUrl || sourceUrl,
    title: chooseText(input.title, existing?.title, fallbackTitle),
    source: {
      kind: identity.sourceKind,
      headline: chooseText(input.headline, existing?.source?.headline, "")
    },
    slides,
    updatedAt
  };

  await ref.update(patch);

  return {
    articleId: identity.articleId,
    isNew: !existing
  };
}

export type UpsertMangaArtifactInput = {
  /** 元記事の URL(canonicalUrl 算出に使う。slides/registration と同じノードへ着地させる)。 */
  articleUrl: string;
  /** NotebookLM で取得したスライドデックの共有URL(ベースURL)。 */
  deckUrl: string;
  status: ViewerArticleStatus;
  stage?: ArtifactStage;
  statusMessage?: string;
  title?: string;
  headline?: string;
};

export type UpsertMangaArtifactResult = {
  articleId: string;
  isNew: boolean;
};

type ExistingMangaArticle = {
  originalUrl?: string;
  title?: string;
  source?: { headline?: string };
  manga?: ExistingArtifact;
};

type ExistingArtifact = {
  status?: ViewerArticleStatus;
  url?: string;
  origin?: string;
  locked?: boolean;
  updatedAt?: string;
  stage?: ArtifactStage;
  statusMessage?: string;
};

/**
 * Write the manga (NotebookLM slide deck) artifact for an article into Firebase.
 *
 * Mirrors {@link upsertSlideArtifact}: a partial update that touches ONLY the
 * `manga` subtree, so `slides` and the registration-owned fields
 * (registeredAt / registeredFrom / lastRegisteredAt) are never clobbered (they
 * are simply absent from the patch). The deck URL is a NotebookLM *artifact* URL
 * — NOT a Google Slides URL — so it is stored verbatim (no normalizeSlidesUrl).
 * title / headline use chooseText so a weaker value never overwrites a stronger
 * existing one. The articleId is recomputed from the article URL so the manga
 * lands on the same node a Shortcut registration / slides write would create.
 */
export async function upsertMangaArtifact(input: UpsertMangaArtifactInput): Promise<UpsertMangaArtifactResult | undefined> {
  const sourceUrl = input.articleUrl;
  if (!sourceUrl) {
    return undefined;
  }

  const identity = createArticleIdentity(sourceUrl);
  const ref = getDb().ref(`/articles/${identity.articleId}`);
  const snapshot = await ref.get();
  const existing: ExistingMangaArticle | undefined = snapshot.exists() ? snapshot.val() : undefined;

  const fallbackTitle = getUrlHost(identity.canonicalUrl) || identity.canonicalUrl;
  const deckUrl = input.deckUrl || existing?.manga?.url || "";
  const updatedAt = nowJstIso();
  const manga = shouldPreserveManualArtifact(existing?.manga)
    ? existing?.manga
    : {
        status: input.status,
        ...(input.stage ? { stage: input.stage } : {}),
        ...(input.statusMessage ? { statusMessage: input.statusMessage } : {}),
        url: deckUrl,
        origin: "automation",
        locked: false,
        updatedAt
      };

  const patch: Record<string, unknown> = {
    articleId: identity.articleId,
    canonicalUrl: identity.canonicalUrl,
    originalUrl: existing?.originalUrl || input.articleUrl || sourceUrl,
    title: chooseText(input.title, existing?.title, fallbackTitle),
    source: {
      kind: identity.sourceKind,
      headline: chooseText(input.headline, existing?.source?.headline, "")
    },
    manga,
    updatedAt
  };

  await ref.update(patch);

  return {
    articleId: identity.articleId,
    isNew: !existing
  };
}


export type UpsertVideoArtifactInput = {
  articleUrl: string;
  videoUrl: string;
  fileId?: string;
  status: ViewerArticleStatus;
  stage?: ArtifactStage;
  statusMessage?: string;
  title?: string;
  headline?: string;
  durationSec?: number;
  sizeBytes?: number;
};

export async function upsertVideoArtifact(input: UpsertVideoArtifactInput): Promise<{ articleId: string; isNew: boolean }> {
  const identity = createArticleIdentity(input.articleUrl);
  const ref = getDb().ref(`/articles/${identity.articleId}`);
  const snapshot = await ref.get();
  const existing = snapshot.exists() ? snapshot.val() as {
    originalUrl?: string; title?: string; source?: { headline?: string }; video?: ExistingArtifact & { fileId?: string };
  } : undefined;
  const updatedAt = nowJstIso();
  const video = shouldPreserveManualArtifact(existing?.video)
    ? existing?.video
    : {
        status: input.status,
        ...(input.stage ? { stage: input.stage } : {}),
        ...(input.statusMessage ? { statusMessage: input.statusMessage } : {}),
        url: input.videoUrl || existing?.video?.url || "",
        fileId: input.fileId || existing?.video?.fileId || "",
        origin: "automation",
        locked: false,
        ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
        ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
        updatedAt
      };
  await ref.update({
    articleId: identity.articleId,
    canonicalUrl: identity.canonicalUrl,
    originalUrl: existing?.originalUrl || input.articleUrl,
    title: chooseText(input.title, existing?.title, getUrlHost(identity.canonicalUrl) || identity.canonicalUrl),
    source: { kind: identity.sourceKind, headline: chooseText(input.headline, existing?.source?.headline, "") },
    video,
    updatedAt
  });
  return { articleId: identity.articleId, isNew: !existing };
}

export function shouldPreserveManualArtifact(artifact: ExistingArtifact | undefined): boolean {
  return artifact?.status === "completed" && artifact.origin === "manual" && artifact.locked === true;
}

const MAX_ARTICLE_SOURCE_LENGTH = 150_000;

/** 抽出/投入された本文をリーダービュー用に保存する。viewerからは読み取り専用。 */
export async function upsertArticleSource(
  articleUrl: string,
  markdown: string,
  format: { version?: number; method?: string; quality?: { verdict: string; chars: number }; title?: string } = {}
): Promise<void> {
  const identity = createArticleIdentity(articleUrl);
  await getDb().ref(`/articleSources/${identity.articleId}`).set({
    markdown: markdown.slice(0, MAX_ARTICLE_SOURCE_LENGTH),
    extractedAt: nowJstIso(),
    ...(format.version !== undefined ? { formatVersion: format.version } : {}),
    ...(format.method ? { formatMethod: format.method.slice(0, 64) } : {}),
    // 取り込みの品質判定(全文/一部)。Viewerが「一部のみ」を表示できるよう本文と一緒に保存する
    ...(format.quality ? { quality: { verdict: format.quality.verdict.slice(0, 16), chars: format.quality.chars } } : {}),
    // 保存済み本文を再利用するとき(取り込み工程)に、取得時のタイトルも一緒に使えるよう控える
    ...(format.title ? { title: format.title.slice(0, MAX_TEXT_LENGTH) } : {})
  });
}

export type StoredArticleSource = {
  markdown: string;
  extractedAt?: string;
  formatVersion?: number;
  formatMethod?: string;
  quality?: { verdict: string; chars: number };
  title?: string;
};

/** 保存済み本文を読む。無ければ undefined。 */
export async function getArticleSource(articleUrl: string): Promise<StoredArticleSource | undefined> {
  const identity = createArticleIdentity(articleUrl);
  const snapshot = await getDb().ref(`/articleSources/${identity.articleId}`).get();
  if (!snapshot.exists()) return undefined;
  const value = snapshot.val() as Partial<StoredArticleSource>;
  if (typeof value.markdown !== "string" || !value.markdown) return undefined;
  return {
    markdown: value.markdown,
    extractedAt: typeof value.extractedAt === "string" ? value.extractedAt : undefined,
    formatVersion: typeof value.formatVersion === "number" ? value.formatVersion : undefined,
    formatMethod: typeof value.formatMethod === "string" ? value.formatMethod : undefined,
    quality:
      value.quality && typeof value.quality.verdict === "string" && typeof value.quality.chars === "number"
        ? { verdict: value.quality.verdict, chars: value.quality.chars }
        : undefined,
    title: typeof value.title === "string" ? value.title : undefined
  };
}

export type ArticleIngestState = {
  verdict: "full" | "partial" | "failed";
  chars: number;
  /** 利用者向けの説明(失敗時)。 */
  message?: string;
};

/**
 * 記事の取り込み状態(全文/一部/取れていない)を記事ノードに書く。Viewer が表示に使う。
 * まだ登録されていない記事には書かない(取り込み状態だけの中身のない記事が一覧に現れるのを防ぐ)。
 */
export async function upsertArticleIngest(articleUrl: string, state: ArticleIngestState): Promise<boolean> {
  const identity = createArticleIdentity(articleUrl);
  const ref = getDb().ref(`/articles/${identity.articleId}`);
  const snapshot = await ref.child("articleId").get();
  if (!snapshot.exists()) return false;
  await ref.child("ingest").set({
    verdict: state.verdict,
    chars: state.chars,
    ...(state.message ? { message: state.message.slice(0, 500) } : {}),
    checkedAt: nowJstIso()
  });
  return true;
}

/** 成果物の現在の状態を読む(再起動時の回収で、処理中のものだけを書き換えるために使う)。 */
export async function getArtifactStatus(
  articleUrl: string,
  artifactType: "slides" | "manga" | "video"
): Promise<string | undefined> {
  const identity = createArticleIdentity(articleUrl);
  const snapshot = await getDb().ref(`/articles/${identity.articleId}/${artifactType}/status`).get();
  return snapshot.exists() ? String(snapshot.val()) : undefined;
}

export async function getArticleReaderMetadata(
  articleUrl: string
): Promise<{ title?: string; tldr?: string }> {
  const identity = createArticleIdentity(articleUrl);
  const snapshot = await getDb().ref(`/articles/${identity.articleId}`).get();
  if (!snapshot.exists()) return {};
  const value = snapshot.val() as { title?: unknown; tldr?: unknown };
  return {
    title: typeof value.title === "string" ? value.title : undefined,
    tldr: typeof value.tldr === "string" ? value.tldr : undefined
  };
}

const MAX_TLDR_LENGTH = 1000;

/**
 * 3行TLDRを記事ノードへ保存する。空値で既存の良値を上書きしない(chooseText)。
 * 一覧の並び(updatedAt順)を乱さないよう updatedAt には触れない。
 */
export async function upsertArticleTldr(articleUrl: string, tldr: string): Promise<void> {
  const identity = createArticleIdentity(articleUrl);
  const ref = getDb().ref(`/articles/${identity.articleId}`);
  const snapshot = await ref.child("tldr").get();
  const existing = snapshot.exists() ? String(snapshot.val()) : undefined;
  const value = chooseText(tldr, existing, "");
  if (!value) return;
  await ref.update({ tldr: value.slice(0, MAX_TLDR_LENGTH) });
}

export type InstapaperDeliveryRecord = {
  status: "processing" | "completed" | "failed";
  contentHash: string;
  readerUrl: string;
  bookmarkId?: string;
  errorCode?: string;
  updatedAt: string;
};

/** Instapaper再送判定用の状態。資格情報や本文は保存しない。 */
export async function getInstapaperDelivery(
  articleUrl: string
): Promise<InstapaperDeliveryRecord | undefined> {
  const identity = createArticleIdentity(articleUrl);
  const snapshot = await getDb().ref(`/instapaperDeliveries/${identity.articleId}`).get();
  return snapshot.exists() ? (snapshot.val() as InstapaperDeliveryRecord) : undefined;
}

/** Instapaper送信結果をviewer非公開の運用領域へ保存する。 */
export async function upsertInstapaperDelivery(
  articleUrl: string,
  record: Omit<InstapaperDeliveryRecord, "updatedAt">
): Promise<void> {
  const identity = createArticleIdentity(articleUrl);
  await getDb().ref(`/instapaperDeliveries/${identity.articleId}`).set({
    ...record,
    updatedAt: nowJstIso()
  });
}

export type ArtifactDiagnosticInput = {
  articleUrl: string;
  artifactType: "slides" | "manga" | "video";
  status: ViewerArticleStatus;
  stage: ArtifactStage;
  code: string;
  detail: string;
  jobId?: string;
  projectArchiveFileId?: string;
  manifestFileId?: string;
};

/** Store operational details outside /articles so ordinary viewers cannot read them. */
export async function upsertArtifactDiagnostic(input: ArtifactDiagnosticInput): Promise<void> {
  const identity = createArticleIdentity(input.articleUrl);
  await getDb().ref(`/artifactDiagnostics/${identity.articleId}/${input.artifactType}`).set({
    status: input.status,
    stage: input.stage,
    code: input.code,
    detail: input.detail,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.projectArchiveFileId ? { projectArchiveFileId: input.projectArchiveFileId } : {}),
    ...(input.manifestFileId ? { manifestFileId: input.manifestFileId } : {}),
    updatedAt: nowJstIso()
  });
}

export async function clearArtifactDiagnostic(articleUrl: string, artifactType: "slides" | "manga" | "video"): Promise<void> {
  const identity = createArticleIdentity(articleUrl);
  await getDb().ref(`/artifactDiagnostics/${identity.articleId}/${artifactType}`).remove();
}

const ARTICLE_AUDIO_MAX_BASE64_LENGTH = 4_000_000;

export type AudioArtifactStatus = "completed" | "expired";

/**
 * 記事に付く音声(1日のまとめの読み上げ)を保存する。
 * 音声データ本体は /articleAudio/{articleId} に base64 で置き、記事ノードには状態と長さだけを書く。
 * 掃除(pruneArticleAudio)が本体を全件読まずに済むよう、/articleAudioIndex に更新日時だけを控える。
 */
export async function upsertArticleAudio(input: {
  articleUrl: string;
  mimeType: string;
  base64: string;
  durationSec: number;
  sizeBytes: number;
}): Promise<{ articleId: string }> {
  if (input.base64.length > ARTICLE_AUDIO_MAX_BASE64_LENGTH) {
    throw new Error(`article audio is too large to store: ${input.base64.length} base64 chars`);
  }
  const identity = createArticleIdentity(input.articleUrl);
  const updatedAt = nowJstIso();
  await getDb().ref().update({
    [`/articleAudio/${identity.articleId}`]: { mimeType: input.mimeType.slice(0, 64), base64: input.base64, updatedAt },
    [`/articleAudioIndex/${identity.articleId}`]: { updatedAt },
    [`/articles/${identity.articleId}/audio`]: {
      status: "completed" satisfies AudioArtifactStatus,
      durationSec: input.durationSec,
      sizeBytes: input.sizeBytes,
      updatedAt
    }
  });
  return { articleId: identity.articleId };
}

/** 保持期間を過ぎた音声の記事IDを返す(判定のみ。純粋関数)。 */
export function selectExpiredAudioIds(
  index: Record<string, { updatedAt?: unknown }> | null | undefined,
  nowMs: number,
  maxAgeDays: number
): string[] {
  const threshold = nowMs - maxAgeDays * 86_400_000;
  return Object.entries(index ?? {})
    .filter(([, entry]) => {
      const updatedMs = typeof entry?.updatedAt === "string" ? Date.parse(entry.updatedAt) : NaN;
      return Number.isFinite(updatedMs) && updatedMs < threshold;
    })
    .map(([articleId]) => articleId);
}

/** 保持期間を過ぎた音声データを削除し、記事側の状態を expired にする。削除した件数を返す。 */
export async function pruneArticleAudio(maxAgeDays: number, nowMs = Date.now()): Promise<number> {
  const snapshot = await getDb().ref("/articleAudioIndex").get();
  const expired = selectExpiredAudioIds(snapshot.val(), nowMs, maxAgeDays);
  if (expired.length === 0) return 0;
  const updates: Record<string, unknown> = {};
  for (const articleId of expired) {
    updates[`/articleAudio/${articleId}`] = null;
    updates[`/articleAudioIndex/${articleId}`] = null;
    updates[`/articles/${articleId}/audio/status`] = "expired" satisfies AudioArtifactStatus;
  }
  await getDb().ref().update(updates);
  return expired.length;
}

// ---- 束(複数記事のまとめ)

export type StoredArticleSummary = {
  articleId: string;
  canonicalUrl: string;
  title: string;
  sourceKind: string;
  deleted: boolean;
};

/** 記事の基本情報を読む(束のメンバー確認用)。無ければ undefined。 */
export async function getArticleSummary(articleId: string): Promise<StoredArticleSummary | undefined> {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(articleId)) return undefined;
  const snapshot = await getDb().ref(`/articles/${articleId}`).get();
  if (!snapshot.exists()) return undefined;
  const value = snapshot.val() as {
    canonicalUrl?: string;
    originalUrl?: string;
    title?: string;
    source?: { kind?: string };
    deletedAt?: string;
  };
  const canonicalUrl = value.canonicalUrl || value.originalUrl || "";
  if (!canonicalUrl) return undefined;
  return {
    articleId,
    canonicalUrl,
    title: value.title || canonicalUrl,
    sourceKind: value.source?.kind || "web",
    deleted: Boolean(value.deletedAt)
  };
}

export type BundleMember = {
  articleId: string;
  title: string;
  canonicalUrl: string;
  status: "included" | "missing";
  reason?: string;
};

/** 束に含めた記事・含められなかった記事の一覧を、束の記事ノードに書く。 */
export async function upsertBundleMembers(bundleUrl: string, members: BundleMember[]): Promise<void> {
  const identity = createArticleIdentity(bundleUrl);
  await getDb()
    .ref(`/articles/${identity.articleId}/bundle`)
    .set({
      members: members.map((member) => ({
        articleId: member.articleId,
        title: member.title.slice(0, MAX_TEXT_LENGTH),
        canonicalUrl: member.canonicalUrl.slice(0, MAX_URL_LENGTH),
        status: member.status,
        ...(member.reason ? { reason: member.reason.slice(0, 200) } : {})
      })),
      createdAt: nowJstIso()
    });
}

export type StoredArticleDigest = { summary: string; points: string[]; sourceHash: string };

/** 記事ごとの要点(束をまたいで再利用する)。無ければ undefined。 */
export async function getArticleDigest(articleId: string): Promise<StoredArticleDigest | undefined> {
  const snapshot = await getDb().ref(`/articleDigests/${articleId}`).get();
  if (!snapshot.exists()) return undefined;
  const value = snapshot.val() as Partial<StoredArticleDigest>;
  if (typeof value.summary !== "string" || !Array.isArray(value.points) || typeof value.sourceHash !== "string") {
    return undefined;
  }
  return { summary: value.summary, points: value.points.map(String), sourceHash: value.sourceHash };
}

export async function setArticleDigest(articleId: string, digest: StoredArticleDigest): Promise<void> {
  await getDb().ref(`/articleDigests/${articleId}`).set({ ...digest, createdAt: nowJstIso() });
}
