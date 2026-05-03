export function extractFirstUrl(text: string): string | undefined {
  const slackLink = text.match(/<((?:https?:\/\/)[^>|]+)(?:\|[^>]*)?>/);
  if (slackLink?.[1]) {
    return slackLink[1];
  }

  return text.match(/https?:\/\/[^\s<>()]+/)?.[0]?.replace(/[.,;:!?）\]}]+$/u, "");
}
