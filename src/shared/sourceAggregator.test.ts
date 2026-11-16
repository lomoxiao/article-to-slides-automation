import test from "node:test";
import assert from "node:assert/strict";
import type { ExtractedContent } from "@local/content-extractor";
import { fetchSourceContent, truncateMarkdown } from "./sourceAggregator.js";
import { SOURCE_UNAVAILABLE_PREFIX } from "./sourceErrors.js";

function extracted(markdown: string, quality: { verdict: "full" | "partial" | "failed"; reasons: string[] }): ExtractedContent {
  return {
    url: "https://example.com/a",
    sourceType: "web-article",
    title: "記事",
    markdown,
    references: [],
    assets: [],
    metadata: { quality: { ...quality, chars: markdown.trim().length } }
  };
}

test("取り込みの関門: 判定が failed なら SourceUnavailableError を投げる", async () => {
  await assert.rejects(
    fetchSourceContent("https://example.com/a", async () => extracted("短い", { verdict: "failed", reasons: ["too_short"] })),
    (error: Error & { reason?: string }) => {
      assert.equal(error.name, "SourceUnavailableError");
      assert.equal(error.reason, "too_short");
      assert.ok(error.message.startsWith(SOURCE_UNAVAILABLE_PREFIX));
      assert.match(error.message, /2文字/);
      return true;
    }
  );
});

test("取り込みの関門: 取得エラー(ExtractionFailedError)も SourceUnavailableError に変換する", async () => {
  const failure = Object.assign(new Error("Request failed with status code 403"), {
    name: "ExtractionFailedError",
    code: "http_403",
    status: 403
  });
  await assert.rejects(
    fetchSourceContent("https://example.com/a", async () => { throw failure; }),
    (error: Error & { reason?: string }) => error.name === "SourceUnavailableError" && error.reason === "http_403"
  );
});

test("取り込みの関門: SessionExpiredError などはそのまま通す", async () => {
  const expired = Object.assign(new Error("要再ログイン"), { name: "SessionExpiredError", domain: "example.com" });
  await assert.rejects(
    fetchSourceContent("https://example.com/a", async () => { throw expired; }),
    (error: Error) => error === expired
  );
});

test("取り込みの関門: partial は生成を続け、quality を返す", async () => {
  const body = "あ".repeat(300);
  const source = await fetchSourceContent("https://example.com/a", async () =>
    extracted(body, { verdict: "partial", reasons: ["too_short"] })
  );
  assert.equal(source.text, body);
  assert.deepEqual(source.quality, { verdict: "partial", chars: 300, reasons: ["too_short"] });
});

test("取り込みの関門: full は quality=full で返す", async () => {
  const source = await fetchSourceContent("https://example.com/a", async () =>
    extracted("あ".repeat(3000), { verdict: "full", reasons: [] })
  );
  assert.equal(source.quality?.verdict, "full");
});

test("取り込みの関門: 取得前にURLを掃除する", async () => {
  let requested = "";
  await fetchSourceContent("https://example.com/a?x=1&amp;y=2", async (url) => {
    requested = url;
    return extracted("あ".repeat(3000), { verdict: "full", reasons: [] });
  });
  assert.equal(requested, "https://example.com/a?x=1&y=2");
});

test("短いMarkdownは変更しない", () => {
  assert.equal(truncateMarkdown("段落1\n\n段落2", 100), "段落1\n\n段落2");
});

test("長いMarkdownは可能なら段落境界で切り詰める", () => {
  const source = "A".repeat(80) + "\n\n" + "B".repeat(80) + "\n\n" + "C".repeat(80);
  const result = truncateMarkdown(source, 210);

  assert.ok(result.endsWith("[本文は文字数上限のため省略されました]"));
  assert.ok(result.includes("A".repeat(80)));
  assert.ok(!result.includes("C".repeat(80)));
  assert.ok(result.length <= 210);
});

test("段落境界がなくても指定上限を超えない", () => {
  const result = truncateMarkdown("文章。".repeat(100), 120);
  assert.ok(result.length <= 120);
  assert.ok(result.endsWith("[本文は文字数上限のため省略されました]"));
});
