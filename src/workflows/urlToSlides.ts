import {
  fetchMultipleSourceContent,
  fetchResearchContent,
  fetchSourceContent,
  type MergedSourceContent
} from "../services/sourceAggregator.js";
import { createGoogleSlidesDeck } from "../services/googleSlides.js";
import { notifySlack } from "../services/slackNotifier.js";
import { summarizeForSlides } from "../services/summarizer.js";

type UrlToSlidesInput = {
  url?: string;
  urls?: string[];
  researchPrompt?: string;
  audience?: string;
  focus?: string;
  pages?: number;
  requestedBy?: string;
  sourceChannelId?: string;
};

export async function runUrlToSlidesWorkflow(input: UrlToSlidesInput) {
  const urls = input.urls ?? (input.url ? [input.url] : undefined);
  let content: MergedSourceContent;

  if (input.researchPrompt) {
    content = await fetchResearchContent(input.researchPrompt);
  } else if (urls && urls.length > 1) {
    content = await fetchMultipleSourceContent(urls);
  } else if (urls?.[0]) {
    const source = await fetchSourceContent(urls[0]);
    content = {
      sources: [{ url: source.url, title: source.title, body: source.text }],
      mergedBody: source.text
    };
  } else {
    throw new Error("URL またはリサーチプロンプトを指定してください");
  }

  const outline = await summarizeForSlides({
    content,
    audience: input.audience,
    focus: input.focus,
    pages: input.pages,
    sources: content.sources.map((source) => ({ url: source.url, title: source.title }))
  });
  const deck = await createGoogleSlidesDeck(outline);

  await notifySlack({
    channelId: input.sourceChannelId,
    requestedBy: input.requestedBy,
    title: outline.title,
    deckUrl: deck.url
  });

  return deck;
}
