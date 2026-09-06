import { config } from "../config.js";
import { deliverReadingEditionToInstapaper } from "../domains/reader/instapaperDelivery.js";
import {
  getArticleReaderMetadata,
  getInstapaperDelivery,
  upsertArticleSource,
  upsertInstapaperDelivery
} from "../shared/firebaseArticleStore.js";
import { fetchSourceContent } from "../shared/sourceAggregator.js";
import { usage } from "./lib/cli.js";
import {
  parseReaderRefreshArgs,
  READER_REFRESH_USAGE
} from "../domains/reader/readerRefreshOptions.js";

let options;
try {
  options = parseReaderRefreshArgs(process.argv.slice(2));
} catch (error) {
  usage(error instanceof Error ? error.message : READER_REFRESH_USAGE);
}
const { url, mode } = options;
const preview = mode === "preview";
const send = mode === "send";

const source = await fetchSourceContent(url);
const stats = {
  url: source.url,
  title: source.title,
  characters: source.text.length,
  paragraphs: source.text.split(/\n{2,}/).filter(Boolean).length,
  headings: source.text.match(/^#{1,6}\s+/gm)?.length ?? 0,
  unorderedItems: source.text.match(/^[-*+]\s+/gm)?.length ?? 0,
  orderedItems: source.text.match(/^\d+[.)]\s+/gm)?.length ?? 0,
  formatVersion: source.readerFormatVersion,
  formatMethod: source.readerFormatMethod,
  mode
};

if (preview) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

await upsertArticleSource(source.url, source.text, {
  version: source.readerFormatVersion,
  method: source.readerFormatMethod
});
console.log("Reader source updated: " + source.url);

if (send) {
  const credentials = getInstapaperCredentials();
  const metadata = await getArticleReaderMetadata(source.url);
  const result = await deliverReadingEditionToInstapaper(
    {
      articleUrl: source.url,
      title: metadata.title || source.title,
      markdown: source.text,
      tldr: metadata.tldr,
      extractedAt: new Date().toISOString()
    },
    {
      readerBaseUrl: config.instapaper.readerBaseUrl,
      credentials
    },
    {
      get: getInstapaperDelivery,
      put: upsertInstapaperDelivery
    }
  );
  console.log(
    result.status === "sent"
      ? "Instapaper updated: " + result.readerUrl
      : "Instapaper unchanged; skipped: " + result.readerUrl
  );
}

console.log(JSON.stringify(stats, null, 2));
process.exit(0);

function getInstapaperCredentials() {
  const {
    consumerKey,
    consumerSecret,
    accessToken,
    accessTokenSecret
  } = config.instapaper;
  const missing = [
    ["INSTAPAPER_CONSUMER_KEY", consumerKey],
    ["INSTAPAPER_CONSUMER_SECRET", consumerSecret],
    ["INSTAPAPER_ACCESS_TOKEN", accessToken],
    ["INSTAPAPER_ACCESS_TOKEN_SECRET", accessTokenSecret]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error("Instapaper credentials are incomplete: " + missing.join(", "));
  }
  return {
    consumerKey: consumerKey!,
    consumerSecret: consumerSecret!,
    accessToken: accessToken!,
    accessTokenSecret: accessTokenSecret!
  };
}
