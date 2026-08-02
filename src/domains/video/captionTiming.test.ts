import assert from "node:assert/strict";
import test from "node:test";
import { calculateCaptionTimeline, findShortCaptionMerge } from "./captionTiming.js";

test("chooses an adjacent phrase for captions shorter than 1.5 seconds after atempo", () => {
  const phrases = [
    { text: "最初の意味単位です", durationSec: 2.4 },
    { text: "短い字幕です", durationSec: 1.4 },
    { text: "最後の意味単位です", durationSec: 2.2 }
  ];
  assert.deepEqual(findShortCaptionMerge(phrases, 1), [1, 2]);
  assert.deepEqual(findShortCaptionMerge(phrases, 0.9), undefined);
  assert.deepEqual(findShortCaptionMerge(phrases.slice(0, 2), 1), [0, 1]);
});

test("builds deterministic cue and scene boundaries from measured phrase durations", () => {
  const result = calculateCaptionTimeline([
    [
      { text: "最初の字幕フレーズです。", durationSec: 2.25 },
      { text: "次の字幕フレーズです。", durationSec: 3.5 }
    ],
    [{ text: "二つ目のシーンです。", durationSec: 4.125 }]
  ]);
  assert.deepEqual(result.sceneDurations, [5.75, 4.125]);
  assert.deepEqual(result.cues, [
    { id: "cue-01-01", sceneIndex: 0, text: "最初の字幕フレーズです。", startMs: 0, endMs: 2250 },
    { id: "cue-01-02", sceneIndex: 0, text: "次の字幕フレーズです。", startMs: 2250, endMs: 5750 },
    { id: "cue-02-01", sceneIndex: 1, text: "二つ目のシーンです。", startMs: 5750, endMs: 9875 }
  ]);
});

test("rejects captions over six seconds", () => {
  assert.throws(() => calculateCaptionTimeline([
    [{ text: "長すぎる字幕フレーズです。", durationSec: 6.01 }]
  ]), /CAPTION_DURATION_INVALID/);
});
