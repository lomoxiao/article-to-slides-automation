import { readFile } from "node:fs/promises";
import { createGoogleSlidesDeck } from "../domains/slides/googleSlides.js";
import type { SlideOutline } from "../types/content.js";
import { usage } from "./lib/cli.js";

const outlinePath = process.argv[2];

if (!outlinePath) {
  usage("Usage: npm run slides:create -- <path-to-outline.json>");
}

const raw = await readFile(outlinePath, "utf8");
const parsed = JSON.parse(raw) as SlideOutline | { deck: SlideOutline } | AutoSlideData[];
const outline = toSlideOutline(parsed);
const deck = await createGoogleSlidesDeck(outline);

console.log(JSON.stringify(deck, null, 2));

type AutoSlideData = {
  type: string;
  title?: string;
  date?: string;
  subhead?: string;
  points?: string[];
  items?: Array<string | { title?: string; desc?: string; label?: string; value?: string; q?: string; a?: string }>;
  leftTitle?: string;
  rightTitle?: string;
  leftItems?: string[];
  rightItems?: string[];
  steps?: string[];
  milestones?: Array<{ label: string; date?: string; state?: string }>;
  lanes?: Array<{ title: string; items: string[] }>;
  stats?: Array<{ label: string; leftValue: string; rightValue: string; trend?: string }>;
  levels?: Array<{ title: string; description: string }>;
  flows?: Array<{ steps: string[] }>;
  text?: string;
  author?: string;
  notes?: string;
};

function toSlideOutline(parsed: SlideOutline | { deck: SlideOutline } | AutoSlideData[]): SlideOutline {
  if (Array.isArray(parsed)) {
    return convertAutoSlideData(parsed);
  }

  if ("deck" in parsed) {
    return parsed.deck;
  }

  return parsed;
}

function convertAutoSlideData(slideData: AutoSlideData[]): SlideOutline {
  const titleSlide = slideData.find((slide) => slide.type === "title");
  const contentSlides = slideData.filter((slide) => slide.type !== "title" && slide.type !== "closing");

  return {
    title: titleSlide?.title ?? "Generated Slides",
    subtitle: titleSlide?.date,
    slides: contentSlides.map((slide) => ({
      title: slide.title ?? slide.type,
      bullets: collectBullets(slide),
      speakerNotes: slide.notes
    }))
  };
}

function collectBullets(slide: AutoSlideData): string[] {
  if (slide.points?.length) {
    return slide.points;
  }

  if (slide.steps?.length) {
    return slide.steps;
  }

  if (slide.leftItems?.length || slide.rightItems?.length) {
    return [
      ...(slide.leftTitle ? [slide.leftTitle] : []),
      ...(slide.leftItems ?? []),
      ...(slide.rightTitle ? [slide.rightTitle] : []),
      ...(slide.rightItems ?? [])
    ];
  }

  if (slide.milestones?.length) {
    return slide.milestones.map((item) => [item.date, item.label].filter(Boolean).join(": "));
  }

  if (slide.lanes?.length) {
    return slide.lanes.flatMap((lane) => [`${lane.title}`, ...lane.items]);
  }

  if (slide.stats?.length) {
    return slide.stats.map((item) => `${item.label}: ${item.leftValue} / ${item.rightValue}`);
  }

  if (slide.levels?.length) {
    return slide.levels.map((item) => `${item.title}: ${item.description}`);
  }

  if (slide.flows?.length) {
    return slide.flows.flatMap((flow) => flow.steps);
  }

  if (slide.items?.length) {
    return slide.items.map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item.q || item.a) {
        return [item.q, item.a].filter(Boolean).join(": ");
      }

      return [item.title ?? item.label, item.value ?? item.desc].filter(Boolean).join(": ");
    });
  }

  if (slide.text) {
    return [slide.author ? `${slide.text} - ${slide.author}` : slide.text];
  }

  if (slide.subhead) {
    return [slide.subhead];
  }

  return [];
}
