import assert from "node:assert/strict";
import test from "node:test";
import { calculateSceneTimeline } from "./composition.js";
import { calculateTempoFactor, shouldRecoverNarration, VideoActionRequiredError } from "./videoPipeline.js";

test("scene boundaries are deterministic sums of measured TTS phrase durations", () => {
  const durations = [8.25, 9.5, 10.125, 11.25, 9.75, 11.125];
  const timeline = calculateSceneTimeline(durations);
  assert.deepEqual(timeline.sceneStarts, [0, 8.25, 17.75, 27.875, 39.125, 48.875]);
  assert.equal(timeline.durationSec, 60);
  assert.deepEqual(calculateSceneTimeline([...durations]), timeline);
});

test("atempo stays within 0.90-1.10 when the clamped result reaches the duration window", () => {
  assert.equal(calculateTempoFactor(66.27), 1.1);
  assert.equal(calculateTempoFactor(53), 0.9);
  assert.equal(calculateTempoFactor(60), 1);
  assert.throws(() => calculateTempoFactor(72), VideoActionRequiredError);
});

test("duration recovery is attempted at most once across job resumes", () => {
  assert.equal(shouldRecoverNarration(66.27, false), true);
  assert.equal(shouldRecoverNarration(66.27, true), false);
  assert.equal(shouldRecoverNarration(60, false), false);
});
