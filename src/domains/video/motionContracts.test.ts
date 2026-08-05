import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { motionOutputSchema } from "./motionPlan.js";
import { isHyperframesProjectValidationOutput } from "./hyperframesCli.js";
import { parseVideoSlackArgs } from "../../utils/parseVideoSlackArgs.js";

test("motion output schema types every single-value enum", () => {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.enum) && record.enum.length === 1) assert.equal(typeof record.type, "string");
    Object.values(record).forEach(visit);
  };
  visit(motionOutputSchema);
});

test("video input accepts optional motion mode and rejects unknown values", () => {
  assert.deepEqual(parseVideoSlackArgs("[video-generate] --url https://example.com --motion rich"), { ok: true, url: "https://example.com", audience: undefined, focus: undefined, motionMode: "rich" });
  assert.equal(parseVideoSlackArgs("[video-generate] --url https://example.com --motion intense").ok, false);
});

test("only project validation findings are eligible for rich-to-basic fallback", () => {
  assert.equal(isHyperframesProjectValidationOutput("lint", JSON.stringify({ ok: false, findings: [{ code: "unsafe" }] })), true);
  assert.equal(isHyperframesProjectValidationOutput("check", JSON.stringify({ ok: false, layout: { ok: false } }) + "\n[browser] closed"), true);
  assert.equal(isHyperframesProjectValidationOutput("check", "Browser failed to launch"), false);
  assert.equal(isHyperframesProjectValidationOutput("check", JSON.stringify({ ok: false, doctor: { ok: false } })), false);
});

test("composition contains deterministic transform-only GSAP motion", async () => {
  const source = await readFile(new URL("./composition.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /random\s*\(|random\(/i);
  assert.doesNotMatch(source, /tl\.(?:to|fromTo)\([^\n]*\b(?:top|left|height|width):/);
  assert.match(source, /captionTimeline/);
  assert.match(source, /inspectionTimes/);
});
