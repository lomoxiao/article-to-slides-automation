import { config } from "../config.js";
import type { SlideOutline, SourceContent } from "../types.js";

export async function summarizeForSlides(source: SourceContent): Promise<SlideOutline> {
  if (config.SUMMARY_PROVIDER === "api") {
    throw new Error("Metered API summarization is not configured. Use codex_job or add an explicit API provider.");
  }

  return createCodexReadyOutline(source);
}

function createCodexReadyOutline(source: SourceContent): SlideOutline {
  return {
    title: source.title,
    subtitle: source.url,
    slides: [
      {
        title: "Codex summary job",
        bullets: [
          "Summarize this article or paper in Japanese.",
          "Convert it into a 5-8 slide Google Slides outline.",
          "Separate key claims, evidence, implications, and caveats."
        ],
        speakerNotes: source.text.slice(0, 4000)
      },
      {
        title: "Input",
        bullets: [
          `URL: ${source.url}`,
          `Title: ${source.title}`,
          "When Codex runs the job, replace this placeholder deck with the final outline."
        ]
      }
    ]
  };
}
