import test from "node:test";
import assert from "node:assert/strict";
import { truncateMarkdown } from "./sourceAggregator.js";

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
