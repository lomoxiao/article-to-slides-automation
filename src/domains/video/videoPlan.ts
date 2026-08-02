import { runCodexPrompt } from "../../shared/codexRunner.js";
import { untrustedSourceSecurityConstraints } from "../../shared/promptGuards.js";
import { countNarrationChars, normalizeCaptionText, videoPlanSchema, type VideoPlan } from "./types.js";

const stringArray = (minItems: number, maxItems: number, maxLength: number, minLength = 1): Record<string, unknown> => ({
  type: "array", minItems, maxItems, items: { type: "string", minLength, maxLength }
});
const visualSchema: Record<string, unknown> = {
  anyOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "keywords"],
      properties: { kind: { type: "string", enum: ["title"] }, keywords: stringArray(2, 3, 20) }
    },
    ...(["keypoints", "steps", "summary"] as const).map((kind) => ({
      type: "object", additionalProperties: false, required: ["kind", "items"],
      properties: { kind: { type: "string", enum: [kind] }, items: stringArray(2, 4, 32) }
    })),
    {
      type: "object", additionalProperties: false, required: ["kind", "left", "right"],
      properties: {
        kind: { type: "string", enum: ["compare"] },
        left: {
          type: "object", additionalProperties: false, required: ["label", "items"],
          properties: { label: { type: "string", minLength: 1, maxLength: 18 }, items: stringArray(1, 3, 28) }
        },
        right: {
          type: "object", additionalProperties: false, required: ["label", "items"],
          properties: { label: { type: "string", minLength: 1, maxLength: 18 }, items: stringArray(1, 3, 28) }
        }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "value", "label"],
      properties: {
        kind: { type: "string", enum: ["number"] },
        value: { type: "string", minLength: 1, maxLength: 12 },
        label: { type: "string", minLength: 2, maxLength: 32 }
      }
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "text"],
      properties: { kind: { type: "string", enum: ["quote"] }, text: { type: "string", minLength: 4, maxLength: 60 } }
    }
  ]
};

export const outputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "title", "scenes"],
  properties: {
    schemaVersion: { type: "integer", enum: [2] },
    title: { type: "string", minLength: 1, maxLength: 100 },
    scenes: {
      type: "array", minItems: 6, maxItems: 8,
      items: {
        type: "object", additionalProperties: false,
        required: ["narration", "captionPhrases", "screenText", "supportingText", "visual", "evidence"],
        properties: {
          narration: { type: "string", minLength: 1, maxLength: 120 },
          captionPhrases: stringArray(1, 3, 32, 8),
          screenText: { type: "string", minLength: 4, maxLength: 40 },
          supportingText: { type: "string", minLength: 15, maxLength: 60 },
          visual: visualSchema,
          evidence: { type: "string", minLength: 1, maxLength: 300 }
        }
      }
    }
  }
};

export async function generateVideoPlan(input: {
  source: string; title?: string; audience?: string; focus?: string; jobDir: string; targetCharacters?: number; previousPlan?: VideoPlan;
}): Promise<VideoPlan> {
  const target = input.targetCharacters ?? 310;
  const previous = input.previousPlan ? `Previous plan (keep schemaVersion, title, scene count, evidence, screenText, supportingText and visual unchanged; rewrite narration and captionPhrases only):
${JSON.stringify(input.previousPlan)}
` : "";
  const prompt = `Create a factual Japanese schemaVersion 2 plan for a 16:9 article explainer video.
Return only JSON matching the supplied schema.
- Use 6-8 scenes.
- Japanese narration total target: ${target} characters; every scene 35-65 characters.
- Split each narration verbatim into 1-3 meaningful captionPhrases. Each phrase should normally be 8-32 characters.
- Ignoring whitespace, captionPhrases joined together must exactly equal narration. Do not paraphrase captions.
- screenText is a 4-40 character headline. supportingText is a 15-60 character explanation.
- Select a visual kind that communicates the scene: title, keypoints, steps, compare, number, quote, or summary.
- Lists contain 2-4 concise items. A compare contains 1-3 items per side. A title contains 2-3 keywords.
- evidence must be an exact contiguous quote from SOURCE and must support the displayed claim.
- Never include HTML, JavaScript, URLs, file paths, commands, or markdown.
- Do not invent claims.
Title hint: ${input.title ?? ""}
Audience: ${input.audience ?? ""}
Focus: ${input.focus ?? ""}
${previous}
${untrustedSourceSecurityConstraints("videoPlan.json")}
<SOURCE>
${input.source.slice(0, 60_000)}
</SOURCE>`;
  let lastError: unknown;
  let retryFeedback = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runCodexPrompt({ prompt: `${prompt}${retryFeedback}`, jobDir: input.jobDir, logLabel: `video-plan-${attempt + 1}`, outputSchema });
      const plan = videoPlanSchema.parse(repairVideoPlanOutput(JSON.parse(stripFence(result.result)), input.source));
      validateVideoPlanContract(plan, input.source, input.previousPlan);
      return plan;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      retryFeedback = `\nThe previous response failed validation. Correct this issue in the next complete response: ${message.slice(0, 1_000)}\n`;
    }
  }
  throw lastError;
}


export function deriveCaptionPhrases(narration: string, suggested: string[] = []): string[] {
  const text = normalizeCaptionText(narration);
  if (text.length <= 32) return [text];
  const minimumCount = Math.ceil(text.length / 32);
  const maximumCount = Math.min(3, Math.floor(text.length / 8));
  const count = Math.max(minimumCount, Math.min(maximumCount, suggested.length || minimumCount));
  const suggestedLengths = suggested.map(normalizeCaptionText).map((phrase) => phrase.length);
  const suggestedTotal = suggestedLengths.reduce((sum, length) => sum + length, 0);
  const phrases: string[] = [];
  let start = 0;
  let suggestedCumulative = 0;
  for (let index = 0; index < count - 1; index += 1) {
    suggestedCumulative += suggestedLengths[index] ?? 0;
    const remainingSegments = count - index - 1;
    const minEnd = start + 8;
    const maxEnd = Math.min(start + 32, text.length - remainingSegments * 8);
    const proportionalTarget = suggestedTotal > 0
      ? Math.round(text.length * suggestedCumulative / suggestedTotal)
      : Math.round(text.length * (index + 1) / count);
    const target = Math.max(minEnd, Math.min(maxEnd, proportionalTarget));
    let bestEnd = target;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let end = minEnd; end <= maxEnd; end += 1) {
      const previous = text[end - 1] ?? "";
      const breakBonus = /[。！？!?]/.test(previous) ? 30 : /[、，,；;：:]/.test(previous) ? 18 : 0;
      const score = breakBonus - Math.abs(end - target);
      if (score > bestScore) {
        bestEnd = end;
        bestScore = score;
      }
    }
    phrases.push(text.slice(start, bestEnd));
    start = bestEnd;
  }
  phrases.push(text.slice(start));
  return phrases;
}

export function repairEvidenceQuote(evidence: string, source: string): string | undefined {
  if (source.includes(evidence)) return evidence;
  const sourceMap: number[] = [];
  let normalizedSource = "";
  for (let index = 0; index < source.length; index += 1) {
    if (/\s/.test(source[index])) continue;
    normalizedSource += source[index];
    sourceMap.push(index);
  }
  const query = normalizeCaptionText(evidence);
  if (query.length < 8) return undefined;
  const candidates = new Set<number>();
  const anchorLength = Math.min(12, query.length);
  for (let offset = 0; offset <= query.length - anchorLength; offset += 4) {
    const anchor = query.slice(offset, offset + anchorLength);
    let found = normalizedSource.indexOf(anchor);
    while (found >= 0 && candidates.size < 500) {
      const start = found - offset;
      if (start >= 0) candidates.add(start);
      found = normalizedSource.indexOf(anchor, found + 1);
    }
  }
  let best: { start: number; end: number; ratio: number } | undefined;
  for (const start of candidates) {
    for (let delta = -4; delta <= 4; delta += 1) {
      const end = start + query.length + delta;
      if (end <= start || end > normalizedSource.length) continue;
      const candidate = normalizedSource.slice(start, end);
      const ratio = levenshteinDistance(query, candidate) / Math.max(query.length, candidate.length);
      if (!best || ratio < best.ratio) best = { start, end, ratio };
    }
  }
  if (!best || best.ratio > 0.12) return undefined;
  return source.slice(sourceMap[best.start], sourceMap[best.end - 1] + 1);
}

function levenshteinDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function repairVideoPlanOutput(value: unknown, source: string): unknown {
  if (!value || typeof value !== "object") return value;
  const plan = value as { scenes?: unknown };
  if (!Array.isArray(plan.scenes)) return value;
  for (const sceneValue of plan.scenes) {
    if (!sceneValue || typeof sceneValue !== "object") continue;
    const scene = sceneValue as { narration?: unknown; captionPhrases?: unknown; evidence?: unknown };
    if (
      typeof scene.narration !== "string"
      || !Array.isArray(scene.captionPhrases)
      || !scene.captionPhrases.every((phrase) => typeof phrase === "string")
    ) continue;
    const phrases = scene.captionPhrases as string[];
    if (normalizeCaptionText(phrases.join("")) !== normalizeCaptionText(scene.narration)) {
      scene.captionPhrases = deriveCaptionPhrases(scene.narration, phrases);
    }
    if (typeof scene.evidence === "string" && !source.includes(scene.evidence)) {
      scene.evidence = repairEvidenceQuote(scene.evidence, source) ?? scene.evidence;
    }
  }
  return value;
}

export function validateVideoPlanContract(plan: VideoPlan, source: string, previousPlan?: VideoPlan): void {
  const total = countNarrationChars(plan.scenes.map((scene) => scene.narration).join(""));
  if (previousPlan) {
    if (total < 240 || total > 380) throw new Error(`Recovered narration must be 240-380 characters; got ${total}`);
    if (plan.schemaVersion !== 2 || plan.title !== previousPlan.title || plan.scenes.length !== previousPlan.scenes.length) {
      throw new Error("Narration recovery changed the plan structure");
    }
    plan.scenes.forEach((scene, index) => {
      const previous = previousPlan.scenes[index];
      if (
        scene.screenText !== previous.screenText
        || scene.supportingText !== previous.supportingText
        || JSON.stringify(scene.visual) !== JSON.stringify(previous.visual)
        || scene.evidence !== previous.evidence
      ) {
        throw new Error(`Narration recovery changed scene ${index + 1} display metadata`);
      }
    });
  } else {
    if (total < 280 || total > 340) throw new Error(`Initial narration must be 280-340 characters; got ${total}`);
    plan.scenes.forEach((scene, index) => {
      const count = countNarrationChars(scene.narration);
      if (count < 35 || count > 65) throw new Error(`Scene ${index + 1} narration must be 35-65 characters; got ${count}`);
    });
  }
  validateEvidence(plan, source);
}

export function targetNarrationCharacters(plan: VideoPlan, measuredSeconds: number): number {
  if (!Number.isFinite(measuredSeconds) || measuredSeconds <= 0) throw new Error("Measured narration duration must be positive");
  const current = countNarrationChars(plan.scenes.map((scene) => scene.narration).join(""));
  return Math.max(240, Math.min(380, Math.round(current * 60 / measuredSeconds)));
}

function validateEvidence(plan: VideoPlan, source: string): void {
  for (const [index, scene] of plan.scenes.entries()) {
    if (!source.includes(scene.evidence)) throw new Error(`Scene ${index + 1} evidence is not present in source`);
  }
}

function stripFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}
