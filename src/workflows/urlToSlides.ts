import { fetchSourceContent } from "../services/contentFetcher.js";
import { createGoogleSlidesDeck } from "../services/googleSlides.js";
import { notifySlack } from "../services/slackNotifier.js";
import { summarizeForSlides } from "../services/summarizer.js";

type UrlToSlidesInput = {
  url: string;
  requestedBy?: string;
  sourceChannelId?: string;
};

export async function runUrlToSlidesWorkflow(input: UrlToSlidesInput) {
  const source = await fetchSourceContent(input.url);
  const outline = await summarizeForSlides(source);
  const deck = await createGoogleSlidesDeck(outline);

  await notifySlack({
    channelId: input.sourceChannelId,
    requestedBy: input.requestedBy,
    title: outline.title,
    deckUrl: deck.url
  });

  return deck;
}

