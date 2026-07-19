import test from "node:test";
import assert from "node:assert/strict";
import { parseSlideArgs } from "./parseSlideArgs.js";

test("bare URL is accepted for backward compatibility", () => {
  const result = parseSlideArgs("https://example.com/article");
  assert.deepEqual(result, {
    ok: true,
    urls: ["https://example.com/article"],
    researchPrompt: undefined,
    pages: undefined
  });
});

test("--url accepts a single URL", () => {
  const result = parseSlideArgs("--url https://a.com");
  assert.ok(result.ok);
  assert.deepEqual(result.urls, ["https://a.com"]);
  assert.equal(result.researchPrompt, undefined);
});

test("--url accepts comma-separated URLs with --pages", () => {
  const result = parseSlideArgs("--url https://a.com,https://b.com --pages 10");
  assert.ok(result.ok);
  assert.deepEqual(result.urls, ["https://a.com", "https://b.com"]);
  assert.equal(result.pages, 10);
});

test("--url tolerates spaces after commas", () => {
  const result = parseSlideArgs("--url https://a.com, https://b.com");
  assert.ok(result.ok);
  assert.deepEqual(result.urls, ["https://a.com", "https://b.com"]);
});

test("--url strips Slack link decoration", () => {
  const result = parseSlideArgs("--url <https://a.com/x|記事タイトル>");
  assert.ok(result.ok);
  assert.deepEqual(result.urls, ["https://a.com/x"]);
});

test("more than 3 URLs is rejected", () => {
  const result = parseSlideArgs("--url https://a.com,https://b.com,https://c.com,https://d.com");
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "URL は最大3件まで指定できます");
});

test("--research with quoted prompt and options", () => {
  const result = parseSlideArgs('--research "AI最新動向" --focus "日本企業への影響" --pages 8');
  assert.ok(result.ok);
  assert.equal(result.urls, undefined);
  assert.equal(result.researchPrompt, "AI最新動向");
  assert.equal(result.focus, "日本企業への影響");
  assert.equal(result.pages, 8);
});

test("--url and --research together is rejected", () => {
  const result = parseSlideArgs("--url https://a.com --research something");
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "--url と --research は同時に指定できません");
});

test("non-integer --pages is rejected", () => {
  const result = parseSlideArgs("--url https://a.com --pages abc");
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "--pages には整数を指定してください");
});

test("unsupported flag is rejected", () => {
  const result = parseSlideArgs("--url https://a.com --unknown x");
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "未対応の引数です: --unknown");
});

test("leftover tokens alongside flags are rejected", () => {
  const result = parseSlideArgs("foo --url https://a.com");
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "解釈できない引数があります: foo");
});

test("empty input is rejected with usage hint", () => {
  const result = parseSlideArgs("");
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "`--url` または `--research` を指定してください");
});

test("unclosed double quote is rejected", () => {
  const result = parseSlideArgs('--research "abc');
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "ダブルクォートが閉じられていません");
});
