/**
 * 記事URLの掃除。Slack経由の投稿や手入力で付く余計な文字を落とす。
 * - Slack がエスケープした `&amp;` を `&` に戻す
 * - 末尾の `>`・句読点・閉じ括弧を除く
 * - ASCII英数字の直後に連結された末尾の非ASCII文字列を除く
 *   (例: `.../nb266051df2bcグラフを` → `.../nb266051df2bc`。
 *    `/wiki/東京` のように区切り文字の直後から始まる日本語パスは正規のURLとして残す)
 */
export function sanitizeArticleUrl(raw: string): string {
  let url = raw.trim().replace(/&amp;/gi, "&");
  let previous: string;
  do {
    previous = url;
    url = url.replace(/[.,;:!?)}\]>）」』】、。]+$/u, "");
    url = url.replace(/([A-Za-z0-9])[^\p{ASCII}]+$/u, "$1");
  } while (url !== previous);
  return url;
}

export function extractFirstUrl(text: string): string | undefined {
  const slackLink = text.match(/<((?:https?:\/\/)[^>|]+)(?:\|[^>]*)?>/);
  if (slackLink?.[1]) {
    return sanitizeArticleUrl(slackLink[1]);
  }

  const match = text.match(/https?:\/\/[^\s<>()]+/)?.[0];
  return match ? sanitizeArticleUrl(match) : undefined;
}

const MAX_ARTICLE_URL_LENGTH = 2048;
const INTERNAL_HOST_SUFFIXES = [".local", ".internal", ".lan", ".localhost", ".home.arpa"];

function isPrivateIpv4(host: string): boolean {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIpv6(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!address.includes(":")) return false;
  return (
    address === "::1" ||
    address === "::" ||
    /^f[cd]/.test(address) || // fc00::/7 (ユニークローカル)
    /^fe[89ab]/.test(address) || // fe80::/10 (リンクローカル)
    address.startsWith("::ffff:") // IPv4射影アドレスは内部宛てに使えるため一律で拒否する
  );
}

/**
 * 取得してよい公開URLかを確かめる。自分のPCや家庭内・社内ネットワークを指すURLは拒否する。
 * 限界: ホスト名を名前解決した先が内部アドレスになる場合までは防がない(個人利用で依頼者が本人に限られる前提)。
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  if (rawUrl.length > MAX_ARTICLE_URL_LENGTH) throw new Error("URLが長すぎます（2,048文字以内）");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("URLの形式を確認してください");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URLは http:// または https:// で指定してください");
  }
  const host = parsed.hostname.toLowerCase();
  const isIpv6 = host.startsWith("[");
  const blocked =
    host === "localhost" ||
    INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    isPrivateIpv4(host) ||
    (isIpv6 && isPrivateIpv6(host)) ||
    (!isIpv6 && !host.includes(".")); // ドットを含まない名前はネットワーク内の機器名
  if (blocked) throw new Error("このURLは取得できません（内部ネットワーク宛てのアドレスです）");
  return parsed;
}

export function isPublicHttpUrl(rawUrl: string): boolean {
  try {
    assertPublicHttpUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}
