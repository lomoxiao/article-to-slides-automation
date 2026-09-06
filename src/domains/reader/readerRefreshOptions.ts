export type ReaderRefreshOptions = {
  url: string;
  mode: "preview" | "update" | "send";
};

export const READER_REFRESH_USAGE =
  "Usage: npm run reader:refresh -- <preview|update|send> <article-url>";

export function parseReaderRefreshArgs(args: string[]): ReaderRefreshOptions {
  if (args.length !== 2) {
    throw new Error(READER_REFRESH_USAGE);
  }
  const [mode, rawUrl] = args;
  if (mode !== "preview" && mode !== "update" && mode !== "send") {
    throw new Error(`Unsupported mode: ${mode}\n${READER_REFRESH_USAGE}`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid article URL: ${rawUrl}\n${READER_REFRESH_USAGE}`);
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    throw new Error(`Article URL must use http or https.\n${READER_REFRESH_USAGE}`);
  }

  return { url: parsedUrl.toString(), mode };
}
