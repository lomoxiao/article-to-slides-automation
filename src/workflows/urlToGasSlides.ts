import { createPendingSlideJob } from "../services/jobStore.js";
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
  return createPendingSlideJob(input);
}
