import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { getDb } from "./firebaseAdmin.js";
import { runCodexPrompt } from "./codexRunner.js";
import { compareRational, CONTRACT_VERSION, divideRational, inRange, mangaPlan21Schema, MANGA_PLAN_SCHEMA_HASH, normalizeRational, rendererSpecSchema, SCHEMA_VERSION, visualIntentSchema, type RendererSpec, type VisualIntent } from "../contracts/mangaPlan21.js";
import { decodeMangaPlanFromFirebase, encodeMangaPlanForFirebase } from "./firebaseMangaPlanCodec.js";
import type { HomeworkJob } from "../types/homework.js";

const roles = ["problem", "error_location", "visualization", "solution", "check", "transfer"] as const;
export const problemClassificationSchema = z.enum(["table_data", "equal_division", "fraction_part_whole", "number_line", "quantity_comparison", "other"]);
export const NUMERIC_EQUATION_PATTERN = String.raw`^\s*-?\d+(?:\.\d+)?\s*[+\-*/xX×÷]\s*-?\d+(?:\.\d+)?\s*[=＝]\s*-?\d+(?:\.\d+)?\s*$`;
const numericEquationSchema = z.string().min(1).max(100).regex(new RegExp(NUMERIC_EQUATION_PATTERN), "must be one numeric equation");
const step = z.object({ id: z.string().min(1).max(100), explanation: z.string().min(1).max(500), expression: numericEquationSchema, result: z.string().min(1).max(100) }).strict();
const panel = z.object({
  role: z.enum(roles), learningPurpose: z.string().min(1).max(200), scene: z.string().min(1).max(500), solutionStepId: z.string().min(1).max(100),
  dialogueText: z.string().min(1).max(500), narration: z.string().max(500).nullable(), visualIntent: visualIntentSchema.nullable(),
  formula: z.array(numericEquationSchema).max(10), emphasisWords: z.array(z.string().max(50)).max(20)
}).strict();
const verification = z.object({ status: z.enum(["verified", "needs_review", "unsupported"]), confidence: z.number().min(0).max(1), warnings: z.array(z.string().max(500)).max(20) }).strict();
const verifiedDraft = z.object({ status: z.literal("verified"), verification: verification.extend({ status: z.literal("verified") }), title: z.string().min(1).max(200), problemClassification: problemClassificationSchema, solutionSteps: z.array(step).min(1).max(20), panels: z.array(panel).length(6) }).strict();
const stoppedDraft = z.object({ status: z.enum(["needs_review", "unsupported"]), verification, reason: z.string().min(1).max(500) }).strict();
export const scenarioDraftSchema = z.discriminatedUnion("status", [verifiedDraft, stoppedDraft]);
export const scenarioOutputSchema = mangaPlan21Schema;
type VerifiedDraft = z.infer<typeof verifiedDraft>;

export type ScenarioError = { code: string; panel: number | null; path: Array<string | number>; reason: string };
class ScenarioValidationError extends Error { constructor(public readonly errors: ScenarioError[]) { super(errors[0]?.reason ?? "Scenario validation failed"); } }
class OptionalVisualError extends Error { constructor(public readonly detail: ScenarioError) { super(detail.reason); } }

const intentByClassification: Record<z.infer<typeof problemClassificationSchema>, VisualIntent["type"] | null> = {
  table_data: "tabular_data", equal_division: "equal_groups", fraction_part_whole: "part_whole", number_line: "scale_marks", quantity_comparison: "compare_quantities", other: null
};

const transportRationalSchema = z.object({ numerator: z.number().int(), denominator: z.number().int().positive() }).strict();
const transportMarkSchema = z.object({ value: transportRationalSchema, label: z.string().min(1).max(200).nullable() }).strict();
const transportIntentSchema = z.object({
  type: z.enum(["tabular_data", "equal_groups", "part_whole", "scale_marks", "compare_quantities"]), requirement: z.enum(["required", "optional"]),
  headers: z.array(z.string().min(1).max(200)).max(10).nullable(), rows: z.array(z.array(z.string().min(1).max(200)).max(10)).max(20).nullable(),
  total: transportRationalSchema.nullable(), groupCount: z.number().int().positive().max(100).nullable(), numerator: z.number().int().nonnegative().nullable(), denominator: z.number().int().positive().max(100).nullable(),
  min: transportRationalSchema.nullable(), max: transportRationalSchema.nullable(), tickCount: z.number().int().min(1).max(20).nullable(), marks: z.array(transportMarkSchema).max(20).nullable(),
  left: transportRationalSchema.nullable(), right: transportRationalSchema.nullable(), leftLabel: z.string().min(1).max(200).nullable(), rightLabel: z.string().min(1).max(200).nullable(), unit: z.string().max(30).nullable()
}).strict();
const transportPanelSchema = panel.omit({ visualIntent: true }).extend({ visualIntent: transportIntentSchema.nullable() }).strict();
export const scenarioTransportSchema = z.object({
  status: z.enum(["verified", "needs_review", "unsupported"]), verification,
  title: z.string().min(1).max(200).nullable(), problemClassification: problemClassificationSchema.nullable(),
  solutionSteps: z.array(step).max(20), panels: z.array(transportPanelSchema).max(6), reason: z.string().min(1).max(500).nullable()
}).strict();

const aiRational = { type: ["object", "null"], additionalProperties: false, required: ["numerator", "denominator"], properties: { numerator: { type: "integer" }, denominator: { type: "integer", minimum: 1 } } };
const aiTextArray = { type: ["array", "null"], maxItems: 10, items: { type: "string", minLength: 1, maxLength: 200 } };
const aiIntent = { type: ["object", "null"], additionalProperties: false, required: ["type", "requirement", "headers", "rows", "total", "groupCount", "numerator", "denominator", "min", "max", "tickCount", "marks", "left", "right", "leftLabel", "rightLabel", "unit"], properties: {
  type: { enum: ["tabular_data", "equal_groups", "part_whole", "scale_marks", "compare_quantities"] }, requirement: { enum: ["required", "optional"] }, headers: aiTextArray,
  rows: { type: ["array", "null"], maxItems: 20, items: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 200 } } }, total: aiRational,
  groupCount: { type: ["integer", "null"], minimum: 1, maximum: 100 }, numerator: { type: ["integer", "null"], minimum: 0 }, denominator: { type: ["integer", "null"], minimum: 1, maximum: 100 },
  min: aiRational, max: aiRational, tickCount: { type: ["integer", "null"], minimum: 1, maximum: 20 }, marks: { type: ["array", "null"], maxItems: 20, items: { type: "object", additionalProperties: false, required: ["value", "label"], properties: { value: { ...aiRational, type: "object" }, label: { type: ["string", "null"], minLength: 1, maxLength: 200 } } } },
  left: aiRational, right: aiRational, leftLabel: { type: ["string", "null"], minLength: 1, maxLength: 200 }, rightLabel: { type: ["string", "null"], minLength: 1, maxLength: 200 }, unit: { type: ["string", "null"], maxLength: 30 }
} };
const aiVerification = { type: "object", additionalProperties: false, required: ["status", "confidence", "warnings"], properties: { status: { enum: ["verified", "needs_review", "unsupported"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, warnings: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 } } } };
export const scenarioAiOutputJsonSchema: Record<string, unknown> = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  required: ["status", "verification", "title", "problemClassification", "solutionSteps", "panels", "reason"], properties: {
    status: { enum: ["verified", "needs_review", "unsupported"] }, verification: aiVerification, title: { type: ["string", "null"], minLength: 1, maxLength: 200 }, problemClassification: { enum: [...problemClassificationSchema.options, null] },
    solutionSteps: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["id", "explanation", "expression", "result"], properties: { id: { type: "string", minLength: 1, maxLength: 100 }, explanation: { type: "string", minLength: 1, maxLength: 500 }, expression: { type: "string", minLength: 1, maxLength: 100, pattern: NUMERIC_EQUATION_PATTERN }, result: { type: "string", minLength: 1, maxLength: 100 } } } },
    panels: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["role", "learningPurpose", "scene", "solutionStepId", "dialogueText", "narration", "visualIntent", "formula", "emphasisWords"], properties: { role: { enum: roles }, learningPurpose: { type: "string", minLength: 1, maxLength: 200 }, scene: { type: "string", minLength: 1, maxLength: 500 }, solutionStepId: { type: "string", minLength: 1, maxLength: 100 }, dialogueText: { type: "string", minLength: 1, maxLength: 500 }, narration: { type: ["string", "null"], maxLength: 500 }, visualIntent: aiIntent, formula: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 100, pattern: NUMERIC_EQUATION_PATTERN } }, emphasisWords: { type: "array", maxItems: 20, items: { type: "string", maxLength: 50 } } } } }, reason: { type: ["string", "null"], minLength: 1, maxLength: 500 }
  } };

export function startScenarioQueueWorker() { const query = getDb().ref("/homeworkJobs").orderByChild("status").equalTo("scenario_queued"); const handler = (snap: { key: string | null }) => { if (snap.key) void processScenarioJob(snap.key); }; query.on("child_added", handler); return () => query.off("child_added", handler); }

export async function processScenarioJob(id: string) {
  const ref = getDb().ref(`/homeworkJobs/${id}`); const tx = await ref.transaction((job: HomeworkJob | null) => job?.status === "scenario_queued" ? { ...job, status: "scenario_generating", stage: "scenario_generating", updatedAt: new Date().toISOString() } : undefined); if (!tx.committed) return;
  const job = tx.snapshot.val() as HomeworkJob; const dir = path.resolve("jobs", "homework", id, "scenario"); await mkdir(dir, { recursive: true });
  try {
    const raw = await runCodexPrompt({ prompt: buildPrompt(job.approvedAnalysis), jobDir: dir, logLabel: "homework-scenario", outputSchema: scenarioAiOutputJsonSchema });
    await ref.update({ status: "scenario_validating", stage: "scenario_validating", updatedAt: new Date().toISOString() });
    let json: unknown; try { json = extractJson(raw.result); } catch (error) { return review(ref, [makeError("AI_JSON_INVALID", null, [], message(error))]); }
    const transport = scenarioTransportSchema.safeParse(json);
    if (!transport.success) { const errors = deepestZodErrors(transport.error); await writeFile(path.join(dir, "validation-error.json"), JSON.stringify(errors, null, 2)); return review(ref, errors); }
    let normalized: unknown; try { normalized = normalizeScenarioTransport(transport.data); } catch (error) { return review(ref, [makeError("AI_DTO_INVALID", null, [], message(error))]); }
    const parsed = scenarioDraftSchema.safeParse(normalized);
    if (!parsed.success) { const errors = deepestZodErrors(parsed.error); await writeFile(path.join(dir, "validation-error.json"), JSON.stringify(errors, null, 2)); return review(ref, errors); }
    if (parsed.data.status !== "verified") { const status = parsed.data.status; await ref.update({ status, stage: status, verification: parsed.data.verification, errors: [makeError(status === "unsupported" ? "CONTENT_UNSUPPORTED" : "AI_REVIEW_REQUIRED", null, [], parsed.data.reason)], error: parsed.data.reason, mangaPlan: null, updatedAt: new Date().toISOString() }); return; }
    const semantics = [...validateVerifiedDraft(parsed.data), ...validateProblemClassification(job.approvedAnalysis, parsed.data)]; if (semantics.length) return review(ref, semantics.map((reason) => makeError("SEMANTIC_INVALID", panelFromReason(reason), [], reason)));
    const warnings: ScenarioError[] = []; const mangaPlan = compileMangaPlan(id, job.approvedAnalysis, parsed.data, warnings);
    const checked = mangaPlan21Schema.safeParse(mangaPlan); if (!checked.success) return review(ref, deepestZodErrors(checked.error, "COMPILED_INVALID"));
    const encoded = encodeMangaPlanForFirebase(checked.data); const decoded = decodeMangaPlanFromFirebase(encoded);
    await ref.update({ status: "scenario_review_required", stage: "scenario_review_required", solutionSteps: parsed.data.solutionSteps, verification: { ...parsed.data.verification, warnings: [...parsed.data.verification.warnings, ...warnings.map((e) => e.reason)] }, mangaPlan: encoded, errors: warnings, error: null, updatedAt: new Date().toISOString() });
    mangaPlan21Schema.parse(decoded);
  } catch (error) {
    const structured = error instanceof ScenarioValidationError ? error.errors : [makeError("PROCESS_FAILED", null, [], message(error))];
    const status = error instanceof ScenarioValidationError ? "needs_review" : "failed";
    await ref.update({ status, stage: status, errors: structured, error: structured[0]?.reason, ...(status === "needs_review" ? { mangaPlan: null } : {}), updatedAt: new Date().toISOString() });
  }
}

async function review(ref: { update(value: unknown): Promise<unknown> }, errors: ScenarioError[]) { await ref.update({ status: "needs_review", stage: "needs_review", verification: { status: "needs_review", confidence: 0, warnings: errors.map((e) => e.reason) }, errors, error: errors[0]?.reason, mangaPlan: null, updatedAt: new Date().toISOString() }); }

export function compileMangaPlan(id: string, approved: unknown, draft: VerifiedDraft, warnings: ScenarioError[] = []) {
  const source = (approved ?? {}) as Record<string, unknown>; const stepIds = new Set(draft.solutionSteps.map((item) => item.id));
  return { schemaVersion: SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, schemaHash: MANGA_PLAN_SCHEMA_HASH, jobId: id, title: draft.title,
    problem: { text: String(source.problemText ?? ""), studentAnswer: String(source.studentAnswer ?? ""), correctAnswer: String(source.correctAnswer ?? source.canonicalAnswer ?? "") }, warnings: warnings.map((e) => e.reason),
    panels: draft.panels.map((item, index) => {
      if (!stepIds.has(item.solutionStepId)) throw new ScenarioValidationError([makeError("STEP_REFERENCE_INVALID", index + 1, ["panels", index, "solutionStepId"], `Unknown solutionStepId: ${item.solutionStepId}`)]);
      let visualAid: RendererSpec | null = null;
      try { visualAid = compileVisualIntent(draft.problemClassification, item.visualIntent, index + 1); } catch (error) {
        const detail = error instanceof OptionalVisualError ? error.detail : makeError("VISUAL_INVALID", index + 1, ["panels", index, "visualIntent"], message(error));
        if (item.visualIntent?.requirement === "optional") warnings.push(detail); else throw new ScenarioValidationError([detail]);
      }
      const character = item.role === "error_location" || item.role === "visualization" ? "teacher" : "hero";
      return { panelNumber: index + 1, learningPurpose: item.learningPurpose, scene: item.scene, solutionStepId: item.solutionStepId, characters: [character], characterPose: { [character]: character === "teacher" ? "pointing" : "thinking" }, characterExpression: { [character]: expressionFor(item.role) }, background: item.role === "check" ? "blackboard" : "classroom", props: [], dialogue: [{ speaker: character === "teacher" ? "先生" : "ハル", text: item.dialogueText, tone: toneFor(item.role) }], narration: item.narration, visualAid, formula: item.formula, emphasisWords: item.emphasisWords, layout: { size: visualAid ? "large" as const : "medium" as const, characterSide: index % 2 === 0 ? "left" as const : "right" as const, visualAidPosition: "center" as const }, assetIds: [`dummy-${character}-${expressionFor(item.role)}`] };
    }) };
}

type ScenarioTransport = z.infer<typeof scenarioTransportSchema>;
type TransportIntent = NonNullable<ScenarioTransport["panels"][number]["visualIntent"]>;
export function normalizeScenarioTransport(input: ScenarioTransport): z.infer<typeof scenarioDraftSchema> {
  if (input.verification.status !== input.status) throw new Error("verification.status must match status");
  if (input.status !== "verified") {
    if (input.title !== null || input.problemClassification !== null || input.solutionSteps.length || input.panels.length || input.reason === null) throw new Error(`${input.status} output must use null title/classification, empty steps/panels, and a reason`);
    return scenarioDraftSchema.parse({ status: input.status, verification: input.verification, reason: input.reason });
  }
  if (input.title === null || input.problemClassification === null || input.reason !== null || input.solutionSteps.length === 0 || input.panels.length !== 6) throw new Error("verified output requires title, classification, solution steps, six panels, and null reason");
  return scenarioDraftSchema.parse({ status: "verified", verification: input.verification, title: input.title, problemClassification: input.problemClassification, solutionSteps: input.solutionSteps, panels: input.panels.map((item) => ({ ...item, visualIntent: item.visualIntent ? normalizeTransportIntent(item.visualIntent) : null })) });
}

function normalizeTransportIntent(input: TransportIntent): VisualIntent {
  const values = { headers: input.headers, rows: input.rows, total: input.total, groupCount: input.groupCount, numerator: input.numerator, denominator: input.denominator, min: input.min, max: input.max, tickCount: input.tickCount, marks: input.marks, left: input.left, right: input.right, leftLabel: input.leftLabel, rightLabel: input.rightLabel, unit: input.unit };
  const take = <K extends keyof typeof values>(required: readonly K[]) => { for (const [key, value] of Object.entries(values)) { const selected = required.includes(key as K); if (selected ? value === null : value !== null) throw new Error(`visualIntent.${key} must be ${selected ? "present" : "null"} for ${input.type}`); } };
  switch (input.type) {
    case "tabular_data": take(["headers", "rows"]); return visualIntentSchema.parse({ type: input.type, requirement: input.requirement, headers: input.headers, rows: input.rows });
    case "equal_groups": take(["total", "groupCount"]); return visualIntentSchema.parse({ type: input.type, requirement: input.requirement, total: input.total, groupCount: input.groupCount });
    case "part_whole": take(["numerator", "denominator"]); return visualIntentSchema.parse({ type: input.type, requirement: input.requirement, numerator: input.numerator, denominator: input.denominator });
    case "scale_marks": take(["min", "max", "tickCount", "marks"]); return visualIntentSchema.parse({ type: input.type, requirement: input.requirement, min: input.min, max: input.max, tickCount: input.tickCount, marks: input.marks?.map((mark) => mark.label === null ? { value: mark.value } : mark) });
    case "compare_quantities": take(["left", "right", "leftLabel", "rightLabel", "unit"]); return visualIntentSchema.parse({ type: input.type, requirement: input.requirement, left: input.left, right: input.right, leftLabel: input.leftLabel, rightLabel: input.rightLabel, unit: input.unit });
  }
}

export function compileVisualIntent(classification: z.infer<typeof problemClassificationSchema>, intent: VisualIntent | null, panelNumber = 1): RendererSpec | null {
  if (!intent) return null; const expected = intentByClassification[classification];
  if (!expected || intent.type !== expected) throw new Error(`VisualIntent ${intent.type} is not allowed for ${classification}`);
  if (intent.type === "tabular_data" && !intent.rows.every((row) => row.length === intent.headers.length)) throw new Error("every table row must match headers length");
  if (intent.type === "part_whole" && intent.numerator > intent.denominator) throw new Error("fraction numerator must not exceed denominator");
  let result: RendererSpec;
  switch (intent.type) {
    case "tabular_data": result = { type: "table", position: "center", headers: intent.headers, rows: intent.rows }; break;
    case "equal_groups": result = { type: "bar_model", position: "center", total: intent.total, groupCount: intent.groupCount, perGroup: divideRational(intent.total, intent.groupCount) }; break;
    case "part_whole": result = { type: "fraction_bar", position: "center", numerator: intent.numerator, denominator: intent.denominator }; break;
    case "scale_marks": if (compareRational(intent.min, intent.max) >= 0) throw new Error("number_line min must be less than max"); if ((intent.marks ?? []).some((m) => !inRange(m.value, intent.min, intent.max))) throw new Error("number_line mark is outside range"); result = { type: "number_line", position: "center", min: intent.min, max: intent.max, tickCount: intent.tickCount, marks: intent.marks ?? [] }; break;
    case "compare_quantities": { const order = compareRational(intent.left, intent.right); const nonzero = intent.right.numerator !== 0; result = { type: "comparison", position: "center", left: intent.left, right: intent.right, leftLabel: intent.leftLabel, rightLabel: intent.rightLabel, unit: intent.unit, operator: order < 0 ? "<" : order > 0 ? ">" : "=", ratio: nonzero ? normalizeRational(intent.left.numerator * intent.right.denominator, intent.left.denominator * intent.right.numerator) : null }; break; }
  }
  const parsed = rendererSpecSchema.safeParse(result); if (!parsed.success) throw new OptionalVisualError(makeError("VISUAL_COMPILE_INVALID", panelNumber, ["panels", panelNumber - 1, "visualIntent"], deepestReason(parsed.error))); return parsed.data;
}

export function validateVerifiedDraft(draft: VerifiedDraft): string[] { const errors: string[] = []; if (draft.panels.map((p) => p.role).join(",") !== roles.join(",")) errors.push("Panel roles must follow the required six-role order."); const ids = new Set(draft.solutionSteps.map((s) => s.id)); draft.panels.forEach((p, i) => { if (!ids.has(p.solutionStepId)) errors.push(`Panel ${i + 1}: Unknown solutionStepId: ${p.solutionStepId}`); }); for (const expression of [...draft.solutionSteps.map((s) => s.expression), ...draft.panels.flatMap((p) => p.formula)]) if (verifyEquation(expression) !== true) errors.push(`Unverified expression: ${expression}`); return [...new Set(errors)]; }

export function validateProblemClassification(approved: unknown, draft: VerifiedDraft): string[] { const source = (approved ?? {}) as Record<string, unknown>; const text = `${String(source.problemText ?? "")} ${String(source.correctAnswer ?? source.canonicalAnswer ?? "")}`; if (/(?:何倍|なん倍|倍率|倍です|how many times|times as)/i.test(text) && draft.problemClassification !== "quantity_comparison") return ["Multiplier problems must use quantity_comparison even when values are presented in a table."]; return []; }

export function buildPrompt(approved: unknown) { return ["Return exactly one JSON object matching the supplied JSON Schema. Generate instructional content only; presentation fields are added by code.", `Use this exact six-panel role order: ${roles.join(", ")}.`, "A panel has at most one visualIntent. Allowed intents only: tabular_data, equal_groups, part_whole, scale_marks, compare_quantities. Never emit derived values.", "For a visualIntent, fill only fields belonging to its type and set every other intent field to null. A missing visualIntent is null.", "For verified output: reason is null. For needs_review or unsupported: title and problemClassification are null, solutionSteps and panels are empty arrays, and reason explains why.", "Classify by the mathematical operation being taught, not by how givens are displayed. A table_data problem asks the learner to read, complete, or aggregate a table. Merely presenting ribbon lengths in a table does not make it table_data. Questions asking 何倍/how many times or dividing by a reference quantity are quantity_comparison.", "VisualIntent must match the classification whitelist. In a multiplier problem, use at most one compare_quantities per panel; separate two comparisons across panels when useful.", "All mathematical values inside VisualIntent are normalized rationals: {numerator: integer, denominator: positive integer}.", "Every solutionSteps.expression and every panels.formula entry must be one numeric equation such as 1.8 / 2.5 = 0.72. Never put variables, Japanese labels, words, or units in these fields. Put explanatory forms such as 赤の倍率 = 赤の長さ ÷ 黄色の長さ in dialogueText or learningPurpose instead.", "Allowed numeric operators are +, -, *, /, x, X, ×, and ÷. Do not use inequalities or chained equations.", `Approved problem: ${JSON.stringify(approved)}`].join("\n"); }
function toneFor(role: typeof roles[number]) { return role === "problem" ? "question" as const : role === "error_location" ? "encourage" as const : role === "solution" || role === "transfer" ? "discovery" as const : "normal" as const; }
function expressionFor(role: typeof roles[number]) { return role === "problem" ? "confused" : role === "transfer" ? "happy" : role === "solution" ? "discovery" : "focused"; }
function makeError(code: string, panel: number | null, path: Array<string | number>, reason: string): ScenarioError { return { code, panel, path, reason }; }
function deepestReason(error: z.ZodError) { return [...error.issues].sort((a, b) => b.path.length - a.path.length)[0]?.message ?? "invalid value"; }
function deepestZodErrors(error: z.ZodError, code = "AI_DTO_INVALID"): ScenarioError[] { const max = Math.max(...error.issues.map((i) => i.path.length)); return error.issues.filter((i) => i.path.length === max).map((i) => makeError(code, typeof i.path[1] === "number" && i.path[0] === "panels" ? i.path[1] + 1 : null, i.path, i.message)); }
function panelFromReason(reason: string) { const match = reason.match(/^Panel (\d+)/); return match ? Number(match[1]) : null; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function extractJson(text: string) { const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""); const a = s.indexOf("{"); const b = s.lastIndexOf("}"); if (a < 0 || b <= a) throw new Error("JSON object not found"); return JSON.parse(s.slice(a, b + 1)); }
export function verifyEquation(input: string): boolean | null { const normalized = input.replace(/＝/g, "=").replace(/[xX×]/g, "*"); const m = normalized.match(/^\s*(-?\d+(?:\.\d+)?)\s*([+\-*\/÷])\s*(-?\d+(?:\.\d+)?)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/); if (!m) return null; const a = decimal(m[1]), b = decimal(m[3]), c = decimal(m[4]); if (!a || !b || !c) return null; const [an, ad] = a, [bn, bd] = b, [cn, cd] = c; let n: bigint, d: bigint; if (m[2] === "+") { n = an * bd + bn * ad; d = ad * bd; } else if (m[2] === "-") { n = an * bd - bn * ad; d = ad * bd; } else if (m[2] === "*" || m[2] === "×") { n = an * bn; d = ad * bd; } else { if (bn === 0n) return false; n = an * bd; d = ad * bn; } return n * cd === cn * d; }
function decimal(s: string): [bigint, bigint] | null { const m = s.match(/^(-?)(\d+)(?:\.(\d+))?$/); if (!m) return null; const x = m[3] ?? ""; return [BigInt(`${m[1]}${m[2]}${x}`), 10n ** BigInt(x.length)]; }
