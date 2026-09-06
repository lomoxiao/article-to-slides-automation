import test from "node:test";
import assert from "node:assert/strict";
import {
  InstapaperApiError,
  InstapaperClient,
  createOAuthAuthorizationHeader,
  exchangeInstapaperAccessToken
} from "./instapaperClient.js";

const credentials = {
  consumerKey: "consumer-key",
  consumerSecret: "consumer-secret",
  accessToken: "access-token",
  accessTokenSecret: "access-secret"
};

test("addBookmark signs and sends URL plus supplied HTML content", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = new InstapaperClient(credentials, {
    now: () => 1_700_000_000_000,
    nonce: () => "fixed-nonce",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(
        JSON.stringify([{ type: "bookmark", bookmark_id: 123, title: "Kobo PoC" }]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  const bookmark = await client.addBookmark({
    url: "https://example.com/reader?id=abc",
    title: "Kobo PoC",
    content: "<article><h1>Kobo PoC</h1><p>日本語本文</p></article>"
  });

  assert.equal(bookmark.bookmark_id, 123);
  assert.equal(request?.url, "https://www.instapaper.com/api/1/bookmarks/add");
  const headers = new Headers(request?.init?.headers);
  assert.match(headers.get("Authorization") ?? "", /^OAuth /);
  assert.match(headers.get("Authorization") ?? "", /oauth_signature=/);
  const body = new URLSearchParams(String(request?.init?.body));
  assert.equal(body.get("url"), "https://example.com/reader?id=abc");
  assert.equal(body.get("content"), "<article><h1>Kobo PoC</h1><p>日本語本文</p></article>");
});

test("private-source bookmark omits URL and includes source label", async () => {
  let body = new URLSearchParams();
  const client = new InstapaperClient(credentials, {
    fetchImpl: async (_url, init) => {
      body = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify([{ type: "bookmark", bookmark_id: 456 }]), { status: 200 });
    }
  });
  await client.addBookmark({ content: "<article>private</article>", privateSource: "multimodal-article-viewer" });
  assert.equal(body.has("url"), false);
  assert.equal(body.get("is_private_from_source"), "multimodal-article-viewer");
});

test("body content participates in the OAuth signature", () => {
  const common = {
    url: "https://www.instapaper.com/api/1/bookmarks/add",
    credentials,
    timestamp: 1_700_000_000,
    nonce: "fixed-nonce"
  };
  const first = createOAuthAuthorizationHeader({ ...common, body: { url: "https://example.com", content: "A" } });
  const second = createOAuthAuthorizationHeader({ ...common, body: { url: "https://example.com", content: "B" } });
  assert.notEqual(first, second);
});

test("API error objects preserve Instapaper error codes", async () => {
  const client = new InstapaperClient(credentials, {
    fetchImpl: async () =>
      new Response(JSON.stringify([{ type: "error", error_code: 1221, message: "Domain opted out" }]), {
        status: 400
      })
  });
  await assert.rejects(
    client.addBookmark({ url: "https://example.com", content: "<article>test</article>" }),
    (error: unknown) => error instanceof InstapaperApiError && error.apiCode === "1221"
  );
});

test("xAuth token exchange parses token and secret", async () => {
  const token = await exchangeInstapaperAccessToken({
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    username: "reader@example.com",
    password: "password",
    now: () => 1_700_000_000_000,
    nonce: () => "fixed-nonce",
    fetchImpl: async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("x_auth_mode"), "client_auth");
      return new Response("oauth_token=token123&oauth_token_secret=secret456", { status: 200 });
    }
  });
  assert.deepEqual(token, { accessToken: "token123", accessTokenSecret: "secret456" });
});
