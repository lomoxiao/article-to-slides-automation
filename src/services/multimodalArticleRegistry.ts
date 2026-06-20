import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import {
  createArticleIdentity,
  getUrlHost,
  normalizeSlidesUrl
} from "./identity.js";

export { createArticleIdentity, normalizeSlidesUrl } from "./identity.js";
export type { ArticleIdentity } from "./identity.js";

export type ViewerArticleStatus = "pending" | "processing" | "completed" | "failed";

export type ViewerArticle = {
  articleId: string;
  canonicalUrl: string;
  originalUrl: string;
  title: string;
  source: {
    kind: "web" | "youtube";
    headline: string;
  };
  slides: {
    status: ViewerArticleStatus;
    url: string;
  };
  manga: {
    status: ViewerArticleStatus;
    url: string;
  };
  updatedAt: string;
};

export type UpsertSlideArticleInput = {
  originalUrl?: string;
  canonicalUrl?: string;
  title?: string;
  headline?: string;
  slidesStatus: ViewerArticleStatus;
  slidesUrl?: string;
  presentationId?: string | null;
  updatedAt?: string;
};

export async function upsertSlideArticle(input: UpsertSlideArticleInput): Promise<ViewerArticle | undefined> {
  const sourceUrl = input.canonicalUrl || input.originalUrl;
  if (!sourceUrl) {
    return undefined;
  }

  const identity = createArticleIdentity(sourceUrl);
  const articlesPath = path.resolve(config.MULTIMODAL_ARTICLES_JSON_PATH);
  const articles = await readArticles(articlesPath);
  const existingIndex = articles.findIndex((article) => articleMatchesIdentity(article, identity.articleId));
  const existing = existingIndex >= 0 ? articles[existingIndex] : undefined;
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const slidesUrl = normalizeSlidesUrl(input.slidesUrl || existing?.slides?.url || "", input.presentationId);
  const fallbackTitle = getUrlHost(identity.canonicalUrl) || identity.canonicalUrl;

  const nextArticle: ViewerArticle = {
    articleId: identity.articleId,
    canonicalUrl: identity.canonicalUrl,
    originalUrl: input.originalUrl || existing?.originalUrl || sourceUrl,
    title: chooseText(input.title, existing?.title, fallbackTitle),
    source: {
      kind: identity.sourceKind,
      headline: chooseText(input.headline, existing?.source?.headline, "")
    },
    slides: {
      status: input.slidesStatus,
      url: slidesUrl
    },
    manga: {
      status: existing?.manga?.status ?? "pending",
      url: existing?.manga?.url ?? ""
    },
    updatedAt
  };

  const nextArticles = existingIndex >= 0
    ? articles
      .map((article, index) => (index === existingIndex ? nextArticle : article))
      .filter((article, index) => index === existingIndex || !articleMatchesIdentity(article, identity.articleId))
    : [...articles, nextArticle];

  await writeArticles(articlesPath, nextArticles);
  return nextArticle;
}

async function readArticles(articlesPath: string): Promise<ViewerArticle[]> {
  if (!existsSync(articlesPath)) {
    return [];
  }

  try {
    const payload = JSON.parse(await readFile(articlesPath, "utf8"));
    return Array.isArray(payload) ? payload.filter(isViewerArticleLike) : [];
  } catch {
    return [];
  }
}

async function writeArticles(articlesPath: string, articles: ViewerArticle[]) {
  await mkdir(path.dirname(articlesPath), { recursive: true });
  await writeFile(articlesPath, `${JSON.stringify(articles, null, 2)}\n`, "utf8");
}

function isViewerArticleLike(value: unknown): value is ViewerArticle {
  return typeof value === "object" && value !== null && "articleId" in value;
}

function articleMatchesIdentity(article: ViewerArticle, articleId: string): boolean {
  return article.articleId === articleId ||
    createArticleIdentity(article.canonicalUrl || article.originalUrl).articleId === articleId;
}

function chooseText(primary: string | undefined, existing: string | undefined, fallback: string): string {
  const primaryTrimmed = primary?.trim();
  if (primaryTrimmed) {
    return primaryTrimmed;
  }
  const existingTrimmed = existing?.trim();
  if (existingTrimmed) {
    return existingTrimmed;
  }
  return fallback;
}
