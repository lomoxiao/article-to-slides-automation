import { loadDotEnv } from "../utils/envFile.js";
import { fail, usage } from "./lib/cli.js";
import {
  INSTAPAPER_SEND_USAGE,
  parseInstapaperSendArgs
} from "../domains/reader/instapaperSendOptions.js";
import { loadReadingSource, ReadingSourcePolicyError } from "../domains/reader/readingSourceLoader.js";
import {
  DEFAULT_DELIVERY_STORE_PATH,
  createLocalDeliveryStore
} from "../domains/reader/localDeliveryStore.js";
import {
  deliverReadingSource,
  renderDeliveryHtml,
  resolveDeliveryMode
} from "../domains/reader/readingDelivery.js";

loadDotEnv();

if (process.argv.includes("--help")) usage(INSTAPAPER_SEND_USAGE);

let options;
try {
  options = parseInstapaperSendArgs(process.argv.slice(2));
} catch (error) {
  usage(error instanceof Error ? error.message : INSTAPAPER_SEND_USAGE);
}

const text = options.origin === "stdin" ? await readStdin() : undefined;

let source;
try {
  source = await loadReadingSource({
    origin: options.origin,
    path: options.path,
    text,
    title: options.title,
    tldr: options.tldr,
    sourceUrl: options.sourceUrl,
    key: options.key
  });
} catch (error) {
  if (error instanceof ReadingSourcePolicyError) fail(error.message);
  throw error;
}

const html = renderDeliveryHtml(source);
const summary = {
  mode: options.mode,
  origin: source.origin,
  deliveryMode: resolveDeliveryMode(source),
  title: source.title,
  key: source.key,
  characters: source.markdown.length,
  headings: source.markdown.match(/^#{1,6}\s+/gm)?.length ?? 0,
  tables: source.markdown.match(/^\|.*\|$/gm)?.length ?? 0,
  htmlBytes: Buffer.byteLength(html, "utf8"),
  sourceUrl: source.sourceUrl ?? null
};

if (options.mode === "preview") {
  // preview は外部状態を一切変えない。ストアにも触らない。
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const credentials = {
  consumerKey: process.env.INSTAPAPER_CONSUMER_KEY || "",
  consumerSecret: process.env.INSTAPAPER_CONSUMER_SECRET || "",
  accessToken: process.env.INSTAPAPER_ACCESS_TOKEN || "",
  accessTokenSecret: process.env.INSTAPAPER_ACCESS_TOKEN_SECRET || ""
};
const missing = Object.entries(credentials)
  .filter(([, value]) => !value)
  .map(([name]) => `INSTAPAPER_${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
if (missing.length) {
  fail(`Instapaper の資格情報が足りません。.env に次を設定してください: ${missing.join(", ")}`);
}

const store = createLocalDeliveryStore(options.storePath ?? DEFAULT_DELIVERY_STORE_PATH);
const result = await deliverReadingSource(
  source,
  {
    credentials: credentials as Required<typeof credentials>,
    privateSourceName: options.privateSourceName
  },
  store
);

console.log(JSON.stringify({ ...summary, result }, null, 2));
console.log(
  result.status === "sent"
    ? `Instapaper へ送信しました (bookmarkId: ${result.bookmarkId})。Kobo で同期してください。`
    : "内容が前回と同じため送信をスキップしました。"
);
process.exit(0);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    fail("--stdin was given but nothing is piped in.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
