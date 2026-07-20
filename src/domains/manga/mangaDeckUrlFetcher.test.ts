import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMangaDeckFetchPrompt,
  classifyMangaDeckFetchResult,
  isTransientChromeFailure,
  MANGA_DECK_DOM_SCRIPT,
  normalizeNotebookLmArtifactUrl,
  shouldRetryMangaDeckFetch
} from "./mangaDeckUrlFetcher.js";

const classify = (result: string) => classifyMangaDeckFetchResult(() => {}, result, "stdout.json");
const notebookId = "665261fc-4ae2-4726-94af-9e91a170c1ba";
const artifactId = "0efa6141-8217-4bea-8c7f-db0954a4e38f";
const artifactUrl = `https://notebooklm.google.com/notebook/${notebookId}/artifact/${artifactId}`;

test("classifies a fetched NotebookLM deck URL and strips query parameters", () => {
  assert.deepEqual(classify(`NBLM_DECK_URL: ${artifactUrl}?utm_source=test`), {
    status: "fetched",
    url: artifactUrl,
    detail: `NBLM_DECK_URL: ${artifactUrl}?utm_source=test`
  });
});

test("rejects non-NotebookLM hosts and malformed artifact paths", () => {
  assert.equal(normalizeNotebookLmArtifactUrl(`https://example.com/notebook/${notebookId}/artifact/${artifactId}`), undefined);
  assert.equal(normalizeNotebookLmArtifactUrl("https://notebooklm.google.com/notebook/n/artifact/a"), undefined);
});

test("deck fetch prompt uses DOM IDs and prohibits clipboard and sharing operations", () => {
  const prompt = buildMangaDeckFetchPrompt("漫画Maker");

  assert.match(prompt, /artifact-library-item/);
  assert.match(prompt, /artifact-labels-/);
  assert.match(prompt, /javascript_toolをaction=javascript_execで1回だけ/);
  assert.match(prompt, /Clipboard API、DOM探索は禁止/);
  assert.doesNotMatch(prompt, /navigator\.clipboard\.readText/);
  assert.doesNotMatch(prompt, /「リンクをコピー」/);
});

test("embedded deck DOM script is valid JavaScript", () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(MANGA_DECK_DOM_SCRIPT));
});

test("identifies transient Chrome connection failures", () => {
  assert.equal(isTransientChromeFailure("Browser extension is not connected"), true);
  assert.equal(isTransientChromeFailure("Claude in Chrome is unavailable"), true);
  assert.equal(isTransientChromeFailure('{"subtype":"error_max_turns"}'), true);
  assert.equal(isTransientChromeFailure("generation failed"), false);
});

test("retries pending and transient retrieval failures only", () => {
  assert.equal(shouldRetryMangaDeckFetch({ status: "pending", detail: "pending" }), true);
  assert.equal(shouldRetryMangaDeckFetch({ status: "retrieval_failed", detail: "timeout", retryable: true }), true);
  assert.equal(shouldRetryMangaDeckFetch({ status: "retrieval_failed", detail: "invalid URL" }), false);
  assert.equal(shouldRetryMangaDeckFetch({ status: "generation_failed", detail: "generation failed" }), false);
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
  assert.equal(classify("NBLM_URL_FAILED: short marker").status, "retrieval_failed");
});

test("treats missing markers as URL retrieval failure", () => {
  assert.equal(classify("unexpected response").status, "retrieval_failed");
});
