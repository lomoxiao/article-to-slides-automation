import { createPendingSlideJob } from "../services/jobStore.js";
import { clearArtifactDiagnostic, upsertSlideArtifact } from "../services/firebaseArticleStore.js";
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
    await upsertSlideArtifact({
      originalUrl: primaryUrl,
      title: input.focus,
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
