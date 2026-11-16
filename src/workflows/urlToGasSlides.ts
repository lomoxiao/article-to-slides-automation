import { createPendingSlideJob } from "../domains/slides/jobStore.js";
import { clearArtifactDiagnostic, restoreDeletedArticle, upsertSlideArtifact } from "../shared/firebaseArticleStore.js";
import type { SlideJob } from "../types/jobs.js";

type UrlToGasSlidesInput = {
  url?: string;
  urls?: string[];
  researchPrompt?: string;
  sourceText?: string;
  sourceTitle?: string;
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
    // 削除済みの記事に生成を依頼した場合は、一覧に戻す(戻さないと成果物ができても見えない)
    await restoreDeletedArticle(primaryUrl).catch(() => false);
    await upsertSlideArtifact({
      originalUrl: primaryUrl,
      title: input.sourceTitle || input.focus,
      headline: input.focus,
      slidesStatus: "processing",
      stage: "slides_generation",
      statusMessage: "Google Slidesを生成しています",
      slidesUrl: ""
    }).then(() => clearArtifactDiagnostic(primaryUrl, "slides")).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Firebase slides artifact update failed: ${message}`);
    });
  }

  return job;
}
