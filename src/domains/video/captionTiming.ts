import type { CaptionCue } from "./types.js";

export type CaptionPhraseTiming = {
  text: string;
  durationSec: number;
};

export function findShortCaptionMerge(
  phrases: CaptionPhraseTiming[],
  tempoFactor: number,
  minimumDurationSec = 1.5
): [number, number] | undefined {
  const index = phrases.findIndex((phrase) => phrase.durationSec / tempoFactor < minimumDurationSec);
  if (index < 0 || phrases.length < 2) return undefined;
  return index < phrases.length - 1 ? [index, index + 1] : [index - 1, index];
}

export function calculateCaptionTimeline(
  scenes: CaptionPhraseTiming[][],
  maximumDurationSec = 6
): { cues: CaptionCue[]; sceneDurations: number[]; phraseDurations: number[][] } {
  const cues: CaptionCue[] = [];
  const sceneDurations: number[] = [];
  const phraseDurations: number[][] = [];
  let cursorMs = 0;
  for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
    const durations: number[] = [];
    for (let phraseIndex = 0; phraseIndex < scenes[sceneIndex].length; phraseIndex += 1) {
      const phrase = scenes[sceneIndex][phraseIndex];
      if (!phrase.text.trim() || !Number.isFinite(phrase.durationSec) || phrase.durationSec <= 0) {
        throw new Error(`Invalid caption phrase at scene ${sceneIndex + 1}, phrase ${phraseIndex + 1}`);
      }
      if (phrase.durationSec > maximumDurationSec) {
        throw new Error(`CAPTION_DURATION_INVALID: scene ${sceneIndex + 1}, phrase ${phraseIndex + 1} is ${phrase.durationSec.toFixed(2)}s`);
      }
      const startMs = cursorMs;
      cursorMs += Math.round(phrase.durationSec * 1_000);
      cues.push({
        id: `cue-${String(sceneIndex + 1).padStart(2, "0")}-${String(phraseIndex + 1).padStart(2, "0")}`,
        sceneIndex,
        text: phrase.text,
        startMs,
        endMs: cursorMs
      });
      durations.push(phrase.durationSec);
    }
    phraseDurations.push(durations);
    sceneDurations.push(durations.reduce((sum, value) => sum + value, 0));
  }
  if (cues.length === 0) throw new Error("Caption timeline contains no cues");
  return { cues, sceneDurations, phraseDurations };
}
