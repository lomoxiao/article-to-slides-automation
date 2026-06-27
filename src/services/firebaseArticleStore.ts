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
    .refine((value) => /^https?:\/\//i.test(value), "url must start with http:// or https://"),
  title: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
  headline: z.string().trim().max(MAX_TEXT_LENGTH).optional()
});

export type RegisterArticleInput = z.input<typeof registerArticleInputSchema>;

export type RegisterArticleResult = {
  articleId: string;
  canonicalUrl: string;
  sourceKind: "web" | "youtube";
  isNew: boolean;
};

type ExistingArticle = {
  originalUrl?: string;
  title?: string;
  source?: { headline?: string };
  registeredFrom?: string;
};

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
    registeredFrom: existing?.registeredFrom || "shortcut",
    lastRegisteredAt: now,
    updatedAt: now
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
  | "slides_generation";

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

export function shouldPreserveManualArtifact(artifact: ExistingArtifact | undefined): boolean {
  return artifact?.status === "completed" && artifact.origin === "manual" && artifact.locked === true;
}

export type ArtifactDiagnosticInput = {
  articleUrl: string;
  artifactType: "slides" | "manga";
  status: ViewerArticleStatus;
  stage: ArtifactStage;
  code: string;
  detail: string;
  jobId?: string;
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
    updatedAt: nowJstIso()
  });
}

export async function clearArtifactDiagnostic(articleUrl: string, artifactType: "slides" | "manga"): Promise<void> {
  const identity = createArticleIdentity(articleUrl);
  await getDb().ref(`/artifactDiagnostics/${identity.articleId}/${artifactType}`).remove();
}
