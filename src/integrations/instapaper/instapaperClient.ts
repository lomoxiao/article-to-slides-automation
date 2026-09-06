import { createHmac, randomBytes } from "node:crypto";

const INSTAPAPER_API_BASE = "https://www.instapaper.com/api/1";

export type InstapaperOAuthCredentials = {
  consumerKey: string;
  consumerSecret: string;
  accessToken?: string;
  accessTokenSecret?: string;
};

export type InstapaperBookmark = {
  type: "bookmark";
  bookmark_id: number | string;
  url?: string;
  title?: string;
  [key: string]: unknown;
};

export type AddInstapaperBookmarkInput = {
  url?: string;
  title?: string;
  content: string;
  privateSource?: string;
};

type InstapaperClientOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
};

type ApiObject = {
  type?: string;
  error_code?: number | string;
  message?: string;
  [key: string]: unknown;
};

export class InstapaperApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly apiCode?: string
  ) {
    super(message);
    this.name = "InstapaperApiError";
  }
}

export class InstapaperClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(
    private readonly credentials: InstapaperOAuthCredentials,
    options: InstapaperClientOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(16).toString("hex"));
  }

  async addBookmark(input: AddInstapaperBookmarkInput): Promise<InstapaperBookmark> {
    requireAccessToken(this.credentials);
    if (!input.content.trim()) throw new Error("Instapaper bookmark content is required");
    if (input.privateSource && input.url) {
      throw new Error("Private-source bookmarks must not include a URL");
    }
    if (!input.privateSource && !input.url) {
      throw new Error("URL bookmarks require a URL");
    }

    const body: Record<string, string> = { content: input.content };
    if (input.url) body.url = input.url;
    if (input.title) body.title = input.title;
    if (input.privateSource) body.is_private_from_source = input.privateSource;

    const objects = await this.postJson("/bookmarks/add", body);
    const apiError = objects.find((item) => item.type === "error");
    if (apiError) throw apiObjectError(apiError, 400);
    const bookmark = objects.find((item) => item.type === "bookmark");
    if (!bookmark) {
      throw new InstapaperApiError("Instapaper response did not include a bookmark", 502);
    }
    return bookmark as InstapaperBookmark;
  }

  private async postJson(path: string, body: Record<string, string>): Promise<ApiObject[]> {
    const response = await this.signedPost(`${INSTAPAPER_API_BASE}${path}`, body);
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new InstapaperApiError(
        `Instapaper returned a non-JSON response (HTTP ${response.status})`,
        response.status
      );
    }
    const objects = Array.isArray(parsed) ? (parsed as ApiObject[]) : [];
    const apiError = objects.find((item) => item.type === "error");
    if (!response.ok) {
      if (apiError) throw apiObjectError(apiError, response.status);
      throw new InstapaperApiError(`Instapaper request failed (HTTP ${response.status})`, response.status);
    }
    return objects;
  }

  private signedPost(url: string, body: Record<string, string>): Promise<Response> {
    const authorization = createOAuthAuthorizationHeader({
      url,
      body,
      credentials: this.credentials,
      timestamp: Math.floor(this.now() / 1000),
      nonce: this.nonce()
    });
    return this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        Accept: "application/json"
      },
      body: new URLSearchParams(body).toString()
    });
  }
}

export async function exchangeInstapaperAccessToken(input: {
  consumerKey: string;
  consumerSecret: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}): Promise<{ accessToken: string; accessTokenSecret: string }> {
  const url = `${INSTAPAPER_API_BASE}/oauth/access_token`;
  const body = {
    x_auth_username: input.username,
    x_auth_password: input.password,
    x_auth_mode: "client_auth"
  };
  const credentials: InstapaperOAuthCredentials = {
    consumerKey: input.consumerKey,
    consumerSecret: input.consumerSecret
  };
  const authorization = createOAuthAuthorizationHeader({
    url,
    body,
    credentials,
    timestamp: Math.floor((input.now ?? Date.now)() / 1000),
    nonce: (input.nonce ?? (() => randomBytes(16).toString("hex")))()
  });
  const response = await (input.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
    },
    body: new URLSearchParams(body).toString()
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new InstapaperApiError(`Instapaper token exchange failed (HTTP ${response.status})`, response.status);
  }
  const values = new URLSearchParams(raw);
  const accessToken = values.get("oauth_token") ?? "";
  const accessTokenSecret = values.get("oauth_token_secret") ?? "";
  if (!accessToken || !accessTokenSecret) {
    throw new InstapaperApiError("Instapaper token response was incomplete", 502);
  }
  return { accessToken, accessTokenSecret };
}

export function createOAuthAuthorizationHeader(input: {
  url: string;
  body: Record<string, string>;
  credentials: InstapaperOAuthCredentials;
  timestamp: number;
  nonce: string;
}): string {
  const oauthParameters: Array<[string, string]> = [
    ["oauth_consumer_key", input.credentials.consumerKey],
    ["oauth_nonce", input.nonce],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", String(input.timestamp)],
    ["oauth_version", "1.0"]
  ];
  if (input.credentials.accessToken) {
    oauthParameters.push(["oauth_token", input.credentials.accessToken]);
  }

  const allParameters: Array<[string, string]> = [...oauthParameters, ...Object.entries(input.body)];
  const normalized = allParameters
    .map(([key, value]) => [oauthEncode(key), oauthEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = compareOAuthValue(leftKey, rightKey);
      return keyOrder === 0 ? compareOAuthValue(leftValue, rightValue) : keyOrder;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const signatureBase = `POST&${oauthEncode(input.url)}&${oauthEncode(normalized)}`;
  const signingKey = `${oauthEncode(input.credentials.consumerSecret)}&${oauthEncode(
    input.credentials.accessTokenSecret ?? ""
  )}`;
  const signature = createHmac("sha1", signingKey).update(signatureBase).digest("base64");
  return `OAuth ${[...oauthParameters, ["oauth_signature", signature] as [string, string]]
    .map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`)
    .join(", ")}`;
}

function oauthEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function compareOAuthValue(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireAccessToken(credentials: InstapaperOAuthCredentials): void {
  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    throw new Error("Instapaper access token and token secret are required");
  }
}

function apiObjectError(object: ApiObject, status: number): InstapaperApiError {
  const code = object.error_code === undefined ? undefined : String(object.error_code);
  const detail = typeof object.message === "string" && object.message ? object.message : "Instapaper API error";
  return new InstapaperApiError(code ? `${detail} (${code})` : detail, status, code);
}
