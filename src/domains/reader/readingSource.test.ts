import test from "node:test";
import assert from "node:assert/strict";
import { flattenWikiLinks, normalizeReadingMarkdown, parseMarkdownDocument } from "./readingSource.js";

test("splits frontmatter and lifts the first heading into a title", () => {
  const parsed = parseMarkdownDocument('---\ndate: "2026-09-12"\nassumptions: 8\n---\n\n# 週次レポート\n\n本文。');
  assert.equal(parsed.frontmatter.date, "2026-09-12");
  assert.equal(parsed.frontmatter.assumptions, "8");
  assert.equal(parsed.title, "週次レポート");
  assert.equal(parsed.body.trim(), "本文。");
});

test("keeps the document intact when there is no frontmatter", () => {
  const parsed = parseMarkdownDocument("# タイトル\n\n本文");
  assert.deepEqual(parsed.frontmatter, {});
  assert.equal(parsed.title, "タイトル");
  assert.equal(parsed.body.trim(), "本文");
});

test("flattens wiki links to a readable source note", () => {
  assert.equal(
    flattenWikiLinks("根拠は [[projects/payments-weekly/evidence/2026-09-10-mastercard-wallet-pay]] です"),
    "根拠は （出典: 2026-09-10-mastercard-wallet-pay） です"
  );
  assert.equal(flattenWikiLinks("[[STATE|現在状態]]"), "（出典: 現在状態）");
});

test("collapses excessive blank lines", () => {
  assert.equal(normalizeReadingMarkdown("a\n\n\n\nb\n"), "a\n\nb");
});
