import { createPendingSlideJob } from "../services/jobStore.js";
import { upsertSlideArticle } from "../services/multimodalArticleRegistry.js";
import type { SlideJob } from "../types/jobs.js";

type UrlToGasSlidesInput = {
  url?: string;
  urls?: string[];
  researchPrompt?: string;
  audience?: string;
  focus?: string;
  pages?: number;
  requestedBy?: string;
  sourceChannelId?: string;
};

export async function runUrlToGasSlidesWorkflow(input: UrlToGasSlidesInput): Promise<SlideJob> {
  const job = await createPendingSlideJob(input);
  const primaryUrl = job.urls?.[0] ?? job.url;

  if (primaryUrl) {
    await upsertSlideArticle({
      originalUrl: primaryUrl,
      title: input.focus,
      headline: input.focus,
      slidesStatus: "processing",
      slidesUrl: "",
      updatedAt: job.updatedAt
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Multimodal article registry update failed: ${message}`);
    });
  }

  return job;
}
