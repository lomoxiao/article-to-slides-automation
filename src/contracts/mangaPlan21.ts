import { z } from "zod";

export const CONTRACT_VERSION = "2.1" as const;
export const SCHEMA_VERSION = "2.1" as const;
export const MANGA_PLAN_SCHEMA_HASH = "sha256:a03f163d16835f82499c547306b503db5ab957039eb0cfe97d121ef29d310259" as const;

const shortText = z.string().min(1).max(200);
export const rationalSchema = z.object({ numerator: z.number().int(), denominator: z.number().int().positive() }).strict()
  .refine((v) => gcd(Math.abs(v.numerator), v.denominator) === 1, "rational must be normalized");
export type Rational = z.infer<typeof rationalSchema>;

const requirement = z.enum(["required", "optional"]);
const markSchema = z.object({ value: rationalSchema, label: shortText.optional() }).strict();
export const visualIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tabular_data"), requirement, headers: z.array(shortText).min(1).max(10), rows: z.array(z.array(shortText).min(1).max(10)).min(1).max(20) }).strict(),
  z.object({ type: z.literal("equal_groups"), requirement, total: rationalSchema, groupCount: z.number().int().positive().max(100) }).strict(),
  z.object({ type: z.literal("part_whole"), requirement, numerator: z.number().int().nonnegative(), denominator: z.number().int().positive().max(100) }).strict(),
  z.object({ type: z.literal("scale_marks"), requirement, min: rationalSchema, max: rationalSchema, tickCount: z.number().int().min(1).max(20), marks: z.array(markSchema).max(20).optional() }).strict(),
  z.object({ type: z.literal("compare_quantities"), requirement, left: rationalSchema, right: rationalSchema, leftLabel: shortText, rightLabel: shortText, unit: z.string().max(30) }).strict()
]);
export type VisualIntent = z.infer<typeof visualIntentSchema>;

const rendererBase = { position: z.enum(["left", "center", "right", "bottom"]) };
export const rendererSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("table"), ...rendererBase, headers: z.array(shortText).min(1).max(10), rows: z.array(z.array(shortText).min(1).max(10)).min(1).max(20) }).strict(),
  z.object({ type: z.literal("bar_model"), ...rendererBase, total: rationalSchema, groupCount: z.number().int().positive().max(100), perGroup: rationalSchema }).strict(),
  z.object({ type: z.literal("fraction_bar"), ...rendererBase, numerator: z.number().int().nonnegative(), denominator: z.number().int().positive().max(100) }).strict(),
  z.object({ type: z.literal("number_line"), ...rendererBase, min: rationalSchema, max: rationalSchema, tickCount: z.number().int().min(1).max(20), marks: z.array(markSchema).max(20) }).strict(),
  z.object({ type: z.literal("comparison"), ...rendererBase, left: rationalSchema, right: rationalSchema, leftLabel: shortText, rightLabel: shortText, unit: z.string().max(30), operator: z.enum(["<", "=", ">"]), ratio: rationalSchema.nullable() }).strict()
]);
export type RendererSpec = z.infer<typeof rendererSpecSchema>;

const dialogue = z.object({ speaker: shortText, text: z.string().min(1).max(500), tone: z.enum(["normal", "question", "encourage", "discovery"]) }).strict();
const panel = z.object({
  panelNumber: z.number().int().min(1).max(6), learningPurpose: shortText, scene: z.string().min(1).max(500), solutionStepId: shortText,
  characters: z.array(shortText).min(1).max(4), characterPose: z.record(z.string().max(100)), characterExpression: z.record(z.string().max(100)),
  background: shortText, props: z.array(shortText).max(20), dialogue: z.array(dialogue).min(1).max(6), narration: z.string().max(500).nullable(),
  visualAid: rendererSpecSchema.nullable(), formula: z.array(z.string().max(100)).max(10), emphasisWords: z.array(z.string().max(50)).max(20),
  layout: z.object({ size: z.enum(["small", "medium", "large"]), characterSide: z.enum(["left", "right"]), visualAidPosition: z.enum(["center", "bottom", "right"]) }).strict(), assetIds: z.array(shortText).max(10)
}).strict().superRefine((value, context) => { const aid = value.visualAid; if (aid?.type === "table" && !aid.rows.every((row) => row.length === aid.headers.length)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["visualAid", "rows"], message: "every row must match headers length" }); if (aid?.type === "fraction_bar" && aid.numerator > aid.denominator) context.addIssue({ code: z.ZodIssueCode.custom, path: ["visualAid", "numerator"], message: "numerator must not exceed denominator" }); });

export const mangaPlan21Schema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), contractVersion: z.literal(CONTRACT_VERSION), schemaHash: z.literal(MANGA_PLAN_SCHEMA_HASH),
  jobId: shortText, title: shortText, problem: z.object({ text: z.string().min(1).max(2000), studentAnswer: z.string().min(1).max(500), correctAnswer: z.string().min(1).max(500) }).strict(),
  panels: z.array(panel).length(6), warnings: z.array(z.string().max(500)).max(20)
}).strict().refine((v) => v.panels.every((p, i) => p.panelNumber === i + 1), "panel numbers must be ordered 1 through 6");
export type MangaPlan21 = z.infer<typeof mangaPlan21Schema>;

export function gcd(a: number, b: number): number { while (b) [a, b] = [b, a % b]; return a || 1; }
export function normalizeRational(numerator: number, denominator: number): Rational {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator === 0) throw new Error("invalid rational");
  const sign = denominator < 0 ? -1 : 1; const d = Math.abs(denominator); const g = gcd(Math.abs(numerator), d);
  return { numerator: sign * numerator / g, denominator: d / g };
}
export function divideRational(value: Rational, divisor: number): Rational { return normalizeRational(value.numerator, value.denominator * divisor); }
export function compareRational(a: Rational, b: Rational): -1 | 0 | 1 { const delta = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator); return delta < 0n ? -1 : delta > 0n ? 1 : 0; }
export function inRange(value: Rational, min: Rational, max: Rational) { return compareRational(value, min) >= 0 && compareRational(value, max) <= 0; }
