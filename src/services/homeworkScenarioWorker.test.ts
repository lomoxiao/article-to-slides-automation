import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, compileMangaPlan, compileVisualIntent, normalizeScenarioTransport, scenarioAiOutputJsonSchema, scenarioDraftSchema, scenarioOutputSchema, scenarioTransportSchema, validateProblemClassification, validateVerifiedDraft, verifyEquation } from "./homeworkScenarioWorker.js";
import { decodeMangaPlanFromFirebase, encodeMangaPlanForFirebase } from "./firebaseMangaPlanCodec.js";

const roles = ["problem", "error_location", "visualization", "solution", "check", "transfer"] as const;
function draft(intent: unknown = null, classification = "equal_division") {
  return scenarioDraftSchema.parse({ status: "verified", verification: { status: "verified", confidence: .98, warnings: [] }, title: "24 ÷ 3", problemClassification: classification,
    solutionSteps: [{ id: "step-1", explanation: "Divide.", expression: "24 / 3 = 8", result: "8" }],
    panels: roles.map((role, index) => ({ role, learningPurpose: `Purpose ${index + 1}`, scene: "Classroom", solutionStepId: "step-1", dialogueText: "Explain.", narration: null, visualIntent: index === 2 ? intent : null, formula: ["24 / 3 = 8"], emphasisWords: ["8"] })) });
}
test("uses exact equation arithmetic", () => { assert.equal(verifyEquation("1.5 x 4 = 6"), true); assert.equal(verifyEquation("24 / 3 = 9"), false); assert.equal(verifyEquation("360 != 390"), null); });
test("compiles all five intents deterministically", () => {
  assert.equal(compileVisualIntent("table_data", { type: "tabular_data", requirement: "required", headers: ["x", "y"], rows: [["1", "2"]] })?.type, "table");
  assert.deepEqual(compileVisualIntent("equal_division", { type: "equal_groups", requirement: "required", total: { numerator: 24, denominator: 1 }, groupCount: 3 }), { type: "bar_model", position: "center", total: { numerator: 24, denominator: 1 }, groupCount: 3, perGroup: { numerator: 8, denominator: 1 } });
  assert.equal(compileVisualIntent("fraction_part_whole", { type: "part_whole", requirement: "required", numerator: 2, denominator: 3 })?.type, "fraction_bar");
  assert.equal(compileVisualIntent("number_line", { type: "scale_marks", requirement: "required", min: { numerator: 0, denominator: 1 }, max: { numerator: 2, denominator: 1 }, tickCount: 2, marks: [] })?.type, "number_line");
  assert.deepEqual((compileVisualIntent("quantity_comparison", { type: "compare_quantities", requirement: "required", left: { numerator: 1, denominator: 2 }, right: { numerator: 1, denominator: 4 }, leftLabel: "A", rightLabel: "B", unit: "L" }) as { operator: string }).operator, ">");
});
test("rejects whitelist mismatches, malformed tables, fractions and marks", () => {
  assert.throws(() => compileVisualIntent("quantity_comparison", { type: "equal_groups", requirement: "required", total: { numerator: 10, denominator: 1 }, groupCount: 2 }), /not allowed/);
  assert.throws(() => compileVisualIntent("table_data", { type: "tabular_data", requirement: "required", headers: ["x", "y"], rows: [["1"]] }), /headers/);
  assert.throws(() => compileVisualIntent("fraction_part_whole", { type: "part_whole", requirement: "required", numerator: 4, denominator: 3 }), /numerator/);
  assert.throws(() => compileVisualIntent("number_line", { type: "scale_marks", requirement: "required", min: { numerator: 0, denominator: 1 }, max: { numerator: 1, denominator: 1 }, tickCount: 2, marks: [{ value: { numerator: 2, denominator: 1 } }] }), /outside/);
});
test("plan and Firebase codec round trip without float math", () => { const parsed = draft({ type: "equal_groups", requirement: "required", total: { numerator: 24, denominator: 1 }, groupCount: 3 }); assert.equal(parsed.status, "verified"); if (parsed.status !== "verified") return; assert.deepEqual(validateVerifiedDraft(parsed), []); const plan = scenarioOutputSchema.parse(compileMangaPlan("job-1", { problemText: "24÷3", studentAnswer: "9", correctAnswer: "8" }, parsed)); assert.deepEqual(decodeMangaPlanFromFirebase(encodeMangaPlanForFirebase(plan)), plan); });
test("optional invalid visual is omitted while required invalid visual aborts", () => {
  const optional = draft({ type: "equal_groups", requirement: "optional", total: { numerator: 10, denominator: 1 }, groupCount: 2 }, "quantity_comparison"); if (optional.status !== "verified") return; const warnings: { reason: string }[] = []; const plan = compileMangaPlan("job", { problemText: "p", studentAnswer: "a", correctAnswer: "b" }, optional, warnings as never[]); assert.equal(plan.panels[2].visualAid, null); assert.equal(warnings.length, 1);
  const required = draft({ type: "equal_groups", requirement: "required", total: { numerator: 10, denominator: 1 }, groupCount: 2 }, "quantity_comparison"); if (required.status === "verified") assert.throws(() => compileMangaPlan("job", { problemText: "p", studentAnswer: "a", correctAnswer: "b" }, required));
});

const emptyIntentFields = { headers: null, rows: null, total: null, groupCount: null, numerator: null, denominator: null, min: null, max: null, tickCount: null, marks: null, left: null, right: null, leftLabel: null, rightLabel: null, unit: null };
function transportWithIntent(visualIntent: Record<string, unknown>, problemClassification = "quantity_comparison") {
  return scenarioTransportSchema.parse({ status: "verified", verification: { status: "verified", confidence: .9, warnings: [] }, title: "リボンの長さ比べ", problemClassification, reason: null,
    solutionSteps: [{ id: "s1", explanation: "黄を1として割る", expression: "1.8 / 2.5 = 0.72", result: "0.72" }],
    panels: roles.map((role, index) => ({ role, learningPurpose: `p${index}`, scene: "classroom", solutionStepId: "s1", dialogueText: "explain", narration: null, visualIntent: index === 2 ? visualIntent : null, formula: ["1.8 / 2.5 = 0.72"], emphasisWords: [] })) });
}
test("Codex transport schema contains no unsupported oneOf keyword", () => {
  const visit = (value: unknown): void => { if (!value || typeof value !== "object") return; const record = value as Record<string, unknown>; assert.equal(Object.prototype.hasOwnProperty.call(record, "oneOf"), false); if (record.properties) assert.deepEqual(new Set(record.required as string[]), new Set(Object.keys(record.properties as object))); for (const child of Object.values(record)) visit(child); };
  visit(scenarioAiOutputJsonSchema);
});
test("normalizes all five wide transport intents", () => {
  const cases = [
    ["table_data", { ...emptyIntentFields, type: "tabular_data", requirement: "required", headers: ["色", "長さ"], rows: [["赤", "1.8"]] }, "tabular_data"],
    ["equal_division", { ...emptyIntentFields, type: "equal_groups", requirement: "required", total: { numerator: 24, denominator: 1 }, groupCount: 3 }, "equal_groups"],
    ["fraction_part_whole", { ...emptyIntentFields, type: "part_whole", requirement: "required", numerator: 2, denominator: 3 }, "part_whole"],
    ["number_line", { ...emptyIntentFields, type: "scale_marks", requirement: "required", min: { numerator: 0, denominator: 1 }, max: { numerator: 2, denominator: 1 }, tickCount: 2, marks: [] }, "scale_marks"],
    ["quantity_comparison", { ...emptyIntentFields, type: "compare_quantities", requirement: "required", left: { numerator: 9, denominator: 5 }, right: { numerator: 5, denominator: 2 }, leftLabel: "赤", rightLabel: "黄", unit: "m" }, "compare_quantities"]
  ] as const;
  for (const [classification, intent, expected] of cases) { const normalized = normalizeScenarioTransport(transportWithIntent(intent, classification)); assert.equal(normalized.status, "verified"); if (normalized.status === "verified") assert.equal(normalized.panels[2].visualIntent?.type, expected); }
});
test("normalizes stopped transport variants", () => {
  for (const status of ["needs_review", "unsupported"] as const) { const value = scenarioTransportSchema.parse({ status, verification: { status, confidence: 0, warnings: ["reason"] }, title: null, problemClassification: null, solutionSteps: [], panels: [], reason: "reason" }); expectStatus(normalizeScenarioTransport(value), status); }
});
test("ribbon percentage regression stays quantity comparison, never bar model", () => {
  const intent = { ...emptyIntentFields, type: "compare_quantities", requirement: "required", left: { numerator: 9, denominator: 5 }, right: { numerator: 5, denominator: 2 }, leftLabel: "赤", rightLabel: "黄", unit: "m" };
  const normalized = normalizeScenarioTransport(transportWithIntent(intent)); assert.equal(normalized.status, "verified"); if (normalized.status !== "verified") return;
  assert.equal(normalized.problemClassification, "quantity_comparison"); assert.equal(normalized.panels[2].visualIntent?.type, "compare_quantities");
  assert.equal(compileMangaPlan("ribbon", { problemText: "ribbon", studentAnswer: "6.12", correctAnswer: "0.72" }, normalized).panels[2].visualAid?.type, "comparison");
});
test("rejects table_data classification for a multiplier question", () => {
  const table = { ...emptyIntentFields, type: "tabular_data", requirement: "required", headers: ["色", "長さ"], rows: [["赤", "1.8m"], ["黄", "2.5m"]] };
  const normalized = normalizeScenarioTransport(transportWithIntent(table, "table_data")); assert.equal(normalized.status, "verified"); if (normalized.status !== "verified") return;
  assert.deepEqual(validateProblemClassification({ problemText: "黄色をもとにすると赤は何倍ですか。" }, normalized), ["Multiplier problems must use quantity_comparison even when values are presented in a table."]);
  const prompt = buildPrompt({ problemText: "黄色をもとにすると赤は何倍ですか。" }); assert.match(prompt, /does not make it table_data/); assert.match(prompt, /quantity_comparison/);
});
test("numeric equation fields reject explanatory labels and units", () => {
  const intent = { ...emptyIntentFields, type: "compare_quantities", requirement: "required", left: { numerator: 9, denominator: 5 }, right: { numerator: 5, denominator: 2 }, leftLabel: "赤", rightLabel: "黄", unit: "m" };
  const raw = transportWithIntent(intent); const invalid = { ...raw, panels: raw.panels.map((panel, index) => index === 0 ? { ...panel, formula: ["赤の倍率 = 赤の長さ ÷ 黄色の長さ"] } : panel) };
  assert.equal(scenarioTransportSchema.safeParse(invalid).success, false);
  for (const equation of ["1 + 2 = 3", "4 - 3 = 1", "1.5 * 2 = 3", "3.1 / 2.5 = 1.24"]) assert.equal(verifyEquation(equation), true);
  for (const invalidEquation of ["赤 = 1.8 / 2.5", "1.8m / 2.5m = 0.72", "1 < 2", "1 + 2 = 4"]) assert.notEqual(verifyEquation(invalidEquation), true);
});
test("transport rejects non-null fields from another intent variant", () => {
  const intent = { ...emptyIntentFields, type: "compare_quantities", requirement: "required", left: { numerator: 9, denominator: 5 }, right: { numerator: 5, denominator: 2 }, leftLabel: "赤", rightLabel: "黄", unit: "m", groupCount: 2 };
  assert.throws(() => normalizeScenarioTransport(transportWithIntent(intent)), /groupCount must be null/);
});
function expectStatus(value: { status: string }, status: string) { assert.equal(value.status, status); }
