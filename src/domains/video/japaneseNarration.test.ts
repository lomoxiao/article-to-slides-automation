import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNarrationForTts } from "./japaneseNarration.js";

test("normalizes common product names and acronyms for Japanese TTS", () => {
  assert.equal(
    normalizeNarrationForTts("2026年、ClaudeとOpenAI APIでMP4を生成します。"),
    "2026年、クロードとオープンエーアイ エーピーアイでエムピーフォーを生成します。"
  );
});

test("spells unknown uppercase acronyms and normalizes percentages", () => {
  assert.equal(
    normalizeNarrationForTts("ABCの精度は80%です。"),
    "エービーシーの精度は80パーセントです。"
  );
});

test("does not change ordinary Japanese narration", () => {
  const text = "記事の重要なポイントを、六十秒で分かりやすく説明します。";
  assert.equal(normalizeNarrationForTts(text), text);
});
