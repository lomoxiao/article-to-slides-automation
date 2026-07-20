import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import type { MergedSourceContent } from "./sourceAggregator.js";
import type { SlideOutline, SourceContent } from "../types/content.js";

type SummarizeInput = {
  content: MergedSourceContent | SourceContent;
  audience?: string;
  focus?: string;
  pages?: number;
  sources?: Array<{ url: string; title: string }>;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatePath = resolve(__dirname, "../../templates/auto-slides-template.md");

export async function summarizeForSlides(input: SummarizeInput | SourceContent): Promise<SlideOutline> {
  if (config.SUMMARY_PROVIDER === "api") {
    throw new Error("Metered API summarization is not configured. Use codex_job or add an explicit API provider.");
  }

  const summarizeInput = normalizeSummarizeInput(input);
  const template = await readFile(templatePath, "utf-8");
  return createCodexReadyOutline(summarizeInput, template);
}

function normalizeSummarizeInput(input: SummarizeInput | SourceContent): SummarizeInput {
  if ("content" in input) {
    return input;
  }

  return {
    content: input,
    sources: [{ url: input.url, title: input.title }]
  };
}

function createCodexReadyOutline(input: SummarizeInput, template: string): SlideOutline {
  const source = getPrimarySource(input.content);
  const sourceText = getSourceText(input.content);
  const sources = input.sources ?? getSources(input.content);
  const optionBullets = [
    input.audience ? `対象読者: ${input.audience}` : undefined,
    input.focus ? `重点事項: ${input.focus}` : undefined,
    input.pages ? `スライド枚数の目安: ${input.pages}枚` : undefined,
    sources.length > 1 ? "最後に出典スライドを追加し、各ソースのタイトルと URL を列挙すること。" : undefined
  ].filter((item): item is string => Boolean(item));

  return {
    title: source.title,
    subtitle: source.url,
    slides: [
      {
        title: "Codex summary job",
        bullets: [
          "Summarize this article or paper in Japanese.",
          "Convert it into a 5-8 slide Google Slides outline.",
          "Separate key claims, evidence, implications, and caveats.",
          ...optionBullets
        ],
        speakerNotes: [
          "Follow the embedded template below.",
          "",
          template.slice(0, 8000),
          "",
          "Source content:",
          sourceText.slice(0, 4000)
        ].join("\n")
      },
      {
        title: "Input",
        bullets: [
          `URL: ${source.url}`,
          `Title: ${source.title}`,
          `Sources: ${sources.length}`,
          "When Codex runs the job, replace this placeholder deck with the final outline."
        ]
      }
    ]
  };
}

function getPrimarySource(content: MergedSourceContent | SourceContent): { url: string; title: string } {
  if ("sources" in content) {
    return content.sources[0] ?? { url: "research", title: "Research summary" };
  }

  return {
    url: content.url,
    title: content.title
  };
}

function getSourceText(content: MergedSourceContent | SourceContent): string {
  return "mergedBody" in content ? content.mergedBody : content.text;
}

function getSources(content: MergedSourceContent | SourceContent): Array<{ url: string; title: string }> {
  if ("sources" in content) {
    return content.sources.map((source) => ({ url: source.url, title: source.title }));
  }

  return [{ url: content.url, title: content.title }];
}
