import test from "node:test";
import assert from "node:assert/strict";
import type { InstapaperDeliveryRecord } from "../../shared/firebaseArticleStore.js";
import { InstapaperApiError } from "../../integrations/instapaper/instapaperClient.js";
import {
  buildReaderUrl,
  deliverReadingEditionToInstapaper,
  type InstapaperDeliveryStore
} from "./instapaperDelivery.js";

const config = {
  readerBaseUrl: "https://example.com/viewer/",
  credentials: {
    consumerKey: "consumer",
    consumerSecret: "consumer-secret",
    accessToken: "token",
    accessTokenSecret: "token-secret"
  }
};

const input = {
  articleUrl: "https://news.example.com/article?utm_source=test&id=7",
  title: "テスト記事",
  markdown: "# 見出し\n\n本文",
  tldr: "- 要点1\n- 要点2\n- 要点3",
  extractedAt: "2026-09-06T20:00:00+09:00"
};

function createStore(initial?: InstapaperDeliveryRecord) {
  let current = initial;
  const writes: Array<Omit<InstapaperDeliveryRecord, "updatedAt">> = [];
  const store: InstapaperDeliveryStore = {
    async get() {
      return current;
    },
    async put(_articleUrl, record) {
      writes.push(record);
      current = { ...record, updatedAt: "2026-09-06T21:00:00+09:00" };
    }
  };
  return { store, writes, get current() { return current; } };
}

test("URL+content形式でReaderパーマリンクとKobo向け本文を送る", async () => {
  const state = createStore();
  let sent: { url: string; title: string; content: string } | undefined;
  const result = await deliverReadingEditionToInstapaper(input, config, state.store, {
    async addBookmark(value) {
      sent = value;
      return { type: "bookmark", bookmark_id: 123 };
    }
  });

  assert.equal(result.status, "sent");
  assert.equal(sent?.url, buildReaderUrl(config.readerBaseUrl, input.articleUrl));
  assert.match(sent?.content ?? "", /data-reader-format="2"/);
  assert.match(sent?.content ?? "", /元記事を開く/);
  assert.deepEqual(state.writes.map((record) => record.status), ["processing", "completed"]);
  assert.equal(state.current?.bookmarkId, "123");
});

test("同じReader URL・本文ハッシュのcompleted送信は繰り返さない", async () => {
  const first = createStore();
  const client = {
    calls: 0,
    async addBookmark() {
      this.calls += 1;
      return { type: "bookmark" as const, bookmark_id: "saved" };
    }
  };
  const delivered = await deliverReadingEditionToInstapaper(input, config, first.store, client);
  const second = createStore(first.current);
  const skipped = await deliverReadingEditionToInstapaper(input, config, second.store, client);

  assert.equal(delivered.status, "sent");
  assert.equal(skipped.status, "skipped");
  assert.equal(client.calls, 1);
  assert.equal(second.writes.length, 0);
});

test("保存日時だけが変わった再実行は繰り返し送らない", async () => {
  const first = createStore();
  const client = {
    calls: 0,
    async addBookmark() {
      this.calls += 1;
      return { type: "bookmark" as const, bookmark_id: "saved" };
    }
  };
  await deliverReadingEditionToInstapaper(input, config, first.store, client);
  const second = createStore(first.current);
  const result = await deliverReadingEditionToInstapaper(
    { ...input, extractedAt: "2026-09-07T08:00:00+09:00" },
    config,
    second.store,
    client
  );

  assert.equal(result.status, "skipped");
  assert.equal(client.calls, 1);
});

test("本文が変わった場合は同じ記事でも再送する", async () => {
  const first = createStore();
  const client = {
    calls: 0,
    async addBookmark() {
      this.calls += 1;
      return { type: "bookmark" as const, bookmark_id: this.calls };
    }
  };
  await deliverReadingEditionToInstapaper(input, config, first.store, client);
  const second = createStore(first.current);
  const result = await deliverReadingEditionToInstapaper(
    { ...input, markdown: `${input.markdown}\n\n追記` },
    config,
    second.store,
    client
  );

  assert.equal(result.status, "sent");
  assert.equal(client.calls, 2);
});

test("APIエラー時は本文や秘密を保存せず、安全なエラーコードだけ記録する", async () => {
  const state = createStore();
  await assert.rejects(
    deliverReadingEditionToInstapaper(input, config, state.store, {
      async addBookmark() {
        throw new InstapaperApiError("secret response", 403, "1221");
      }
    }),
    /secret response/
  );

  assert.equal(state.current?.status, "failed");
  assert.equal(state.current?.errorCode, "1221");
  assert.equal("content" in (state.current ?? {}), false);
});
