import { z } from "zod";
import { createArticleIdentity, getUrlHost } from "./identity.js";
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

  const now = new Date().toISOString();
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
