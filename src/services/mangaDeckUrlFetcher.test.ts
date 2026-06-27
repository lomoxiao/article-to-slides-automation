import assert from "node:assert/strict";
import test from "node:test";
import { classifyMangaDeckFetchResult } from "./mangaDeckUrlFetcher.js";

const classify = (result: string) => classifyMangaDeckFetchResult(() => {}, result, "stdout.json");

test("classifies a fetched NotebookLM deck URL and strips query parameters", () => {
  assert.deepEqual(classify("NBLM_DECK_URL: https://notebooklm.google.com/notebook/n/artifact/a?utm_source=test"), {
    status: "fetched",
    url: "https://notebooklm.google.com/notebook/n/artifact/a",
    detail: "NBLM_DECK_URL: https://notebooklm.google.com/notebook/n/artifact/a?utm_source=test"
  });
});

test("classifies a still-generating deck as pending", () => {
  assert.equal(classify("NBLM_DECK_PENDING").status, "pending");
});

test("separates deck generation failures from URL retrieval failures", () => {
  assert.equal(classify("NBLM_DECK_GENERATION_FAILED: generation error").status, "generation_failed");
  assert.equal(classify("NBLM_DECK_URL_FAILED: share button missing").status, "retrieval_failed");
});

test("maps the legacy generic failure marker to URL retrieval failure", () => {
  assert.equal(classify("NBLM_DECK_FAILED: legacy error").status, "retrieval_failed");
});

test("treats missing markers as URL retrieval failure", () => {
  assert.equal(classify("unexpected response").status, "retrieval_failed");
});
