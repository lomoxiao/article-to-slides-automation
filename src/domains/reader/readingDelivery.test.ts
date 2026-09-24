import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDeliveryStore } from "./localDeliveryStore.js";
import {
  computeContentHash,
  deliverReadingSource,
  renderDeliveryHtml,
  resolveDeliveryMode
} from "./readingDelivery.js";
import type { ReadingSource } from "./readingSource.js";
import { InstapaperApiError } from "../../integrations/instapaper/instapaperClient.js";

const credentials = {
  consumerKey: "ck",
  consumerSecret: "cs",
  accessToken: "at",
  accessTokenSecret: "ats"
};

function source(overrides: Partial<ReadingSource> = {}): ReadingSource {
  return {
    key: "/vault/artifacts/report.md",
    title: "週次レポート",
    markdown: "## 節\n\n本文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    capturedAt: "2026-09-12T13:00:00.000Z",
    origin: "vault-artifact",
    richText: true,
    ...overrides
  };
}

test("uses private source when there is no source url", () => {
  assert.equal(resolveDeliveryMode(source()), "private-source");
  assert.equal(resolveDeliveryMode(source({ sourceUrl: "https://e.com/a" })), "url-content");
});

test("sends a private-source bookmark and records the delivery", async () => {
  const store = createMemoryDeliveryStore(() => new Date("2026-09-12T13:00:00.000Z"));
  const calls: Array<Record<string, unknown>> = [];
  const result = await deliverReadingSource(source(), { credentials }, store, {
    async addBookmark(input) {
      calls.push(input);
      return { type: "bookmark", bookmark_id: 4242 };
    }
  });

  assert.equal(result.status, "sent");
  assert.equal(result.mode, "private-source");
  assert.equal(result.bookmarkId, "4242");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, undefined);
  assert.equal(calls[0].privateSource, "personal-knowledge-vault");
  assert.match(String(calls[0].content), /<ul class="reader-table-list">/);
  assert.doesNotMatch(String(calls[0].content), /<table>/);
});

test("skips an unchanged source instead of creating a duplicate bookmark", async () => {
  const store = createMemoryDeliveryStore();
  const writer = {
    calls: 0,
    async addBookmark() {
      this.calls += 1;
      return { type: "bookmark" as const, bookmark_id: 1 };
    }
  };
  await deliverReadingSource(source(), { credentials }, store, writer);
  const second = await deliverReadingSource(source(), { credentials }, store, writer);

  assert.equal(second.status, "skipped");
  assert.equal(second.bookmarkId, "1");
  assert.equal(writer.calls, 1);
});

test("resends when the body changes", async () => {
  const store = createMemoryDeliveryStore();
  const writer = {
    calls: 0,
    async addBookmark() {
      this.calls += 1;
      return { type: "bookmark" as const, bookmark_id: this.calls };
    }
  };
  await deliverReadingSource(source(), { credentials }, store, writer);
  const second = await deliverReadingSource(
    source({ markdown: "## 節\n\n差し替えた本文" }),
    { credentials },
    store,
    writer
  );
  assert.equal(second.status, "sent");
  assert.equal(writer.calls, 2);
});

test("capture time alone does not trigger a resend", () => {
  assert.equal(
    computeContentHash(source({ capturedAt: "2026-09-12T13:00:00.000Z" })),
    computeContentHash(source({ capturedAt: "2026-10-01T00:00:00.000Z" }))
  );
});

test("records the api error code and rethrows", async () => {
  const store = createMemoryDeliveryStore();
  await assert.rejects(
    deliverReadingSource(source(), { credentials }, store, {
      async addBookmark() {
        throw new InstapaperApiError("nope", 403, "1040");
      }
    }),
    InstapaperApiError
  );
  const record = await store.get("/vault/artifacts/report.md");
  assert.equal(record?.status, "failed");
  assert.equal(record?.errorCode, "1040");
});

test("renders tables as lists only through the opt-in rich text path", () => {
  assert.match(renderDeliveryHtml(source()), /<ul class="reader-table-list">/);
  assert.doesNotMatch(renderDeliveryHtml(source()), /<table>/);
  assert.doesNotMatch(renderDeliveryHtml(source({ richText: false })), /reader-table-list/);
});
