import { z } from "zod";
import type { VideoPlan } from "./types.js";

const forbiddenValue = /[<>`{};\\]|(?:\?{2,})|(?:\b(?:https?|ftp|file):\/\/)|(?:www\.)|(?:\.\.?\/)|(?:[A-Za-z]:[\\/])|(?:\$\()|(?:=>)|(?:[.#][A-Za-z_-][\w-]*)|(?:\[[A-Za-z][^\]]*\])|(?:\b(?:function|eval|gsap|document|window|querySelector|url)\s*(?:\.|\())/i;
const diagramText = (minimum: number, maximum: number) =>
  z.string().min(minimum).max(maximum).refine((value) => !forbiddenValue.test(value), "unsafe diagram text");

export const motionModeSchema = z.enum(["basic", "rich"]);
export type MotionMode = z.infer<typeof motionModeSchema>;
export const diagramToneSchema = z.enum(["neutral", "accent", "positive", "warning", "danger"]);

const diagramItemSchema = z.object({
  label: diagramText(1, 24),
  detail: diagramText(1, 40).optional(),
  tone: diagramToneSchema.default("neutral")
}).strict();

const stepsSchema = z.array(diagramItemSchema).min(3).max(5);
const pathsSchema = z.array(diagramItemSchema).min(2).max(4);
const groupSchema = z.object({ label: diagramText(1, 24), items: z.array(diagramText(1, 24)).min(1).max(3) }).strict();

const topologySchema = z.object({
  kind: z.literal("topology"),
  nodes: z.array(diagramItemSchema).min(2).max(6),
  edges: z.array(z.object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    label: diagramText(1, 24).optional(),
    state: z.enum(["active", "removed", "promoted"]).default("active")
  }).strict()).min(1).max(8)
}).strict().superRefine((diagram, ctx) => {
  diagram.edges.forEach((edge, index) => {
    if (edge.from >= diagram.nodes.length || edge.to >= diagram.nodes.length || edge.from === edge.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", index], message: "edge references an invalid node" });
    }
  });
});

const migrationSchema = z.object({ kind: z.literal("migration"), before: groupSchema, after: groupSchema }).strict();
const cycleSchema = z.object({ kind: z.literal("cycle"), center: diagramText(1, 24).optional(), steps: stepsSchema }).strict();
const loopSchema = z.object({ kind: z.literal("loop"), center: diagramText(1, 24).optional(), steps: stepsSchema }).strict();
const timelineSchema = z.object({ kind: z.literal("timeline"), steps: stepsSchema }).strict();
const branchSchema = z.object({ kind: z.literal("branch"), source: diagramItemSchema, paths: pathsSchema }).strict();
const causeEffectSchema = z.object({ kind: z.literal("cause-effect"), source: diagramItemSchema, paths: pathsSchema }).strict();
const layersSchema = z.object({
  kind: z.literal("layers"),
  layers: z.array(diagramItemSchema).min(2).max(4),
  focusIndex: z.number().int().nonnegative()
}).strict().superRefine((diagram, ctx) => {
  if (diagram.focusIndex >= diagram.layers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["focusIndex"], message: "focusIndex is outside layers" });
  }
});
const gatesSchema = z.object({
  kind: z.literal("gates"),
  token: diagramText(1, 16),
  gates: z.array(diagramItemSchema).min(2).max(4),
  result: diagramText(1, 24),
  blocked: diagramText(1, 24).optional()
}).strict();
const metricSchema = z.object({
  kind: z.literal("metric"), value: diagramText(1, 12), label: diagramText(1, 24), comparison: diagramText(1, 24).optional()
}).strict();
const legacySchema = z.object({ kind: z.literal("legacy") }).strict();

export const motionDiagramSchema = z.union([
  legacySchema, topologySchema, migrationSchema, cycleSchema, branchSchema, loopSchema,
  layersSchema, gatesSchema, timelineSchema, metricSchema, causeEffectSchema
]);
export type MotionDiagram = z.infer<typeof motionDiagramSchema>;
export type MotionDiagramKind = MotionDiagram["kind"];

export const motionSceneSchema = z.object({ sceneIndex: z.number().int().nonnegative(), diagram: motionDiagramSchema }).strict();
export const motionPlanSchema = z.object({
  schemaVersion: z.literal(1),
  theme: z.literal("dark-cyan-v1"),
  scenes: z.array(motionSceneSchema).min(6).max(8)
}).strict();
export type MotionPlan = z.infer<typeof motionPlanSchema>;

export function validateMotionPlanContract(motionPlan: MotionPlan, videoPlan: VideoPlan, requireRich = true): void {
  if (motionPlan.scenes.length !== videoPlan.scenes.length) throw new Error("MotionPlan scene count must match VideoPlan");
  motionPlan.scenes.forEach((scene, index) => {
    if (scene.sceneIndex !== index) throw new Error(`MotionPlan sceneIndex must be ordered; got ${scene.sceneIndex} at ${index}`);
  });
  if (!requireRich) return;
  const kinds = motionPlan.scenes.map((scene) => scene.diagram.kind).filter((kind) => kind !== "legacy");
  if (kinds.length < 4) throw new Error(`MotionPlan must contain at least 4 rich diagrams; got ${kinds.length}`);
  if (new Set(kinds).size < 3) throw new Error("MotionPlan must use at least 3 rich diagram kinds");
  for (let index = 1; index < motionPlan.scenes.length; index += 1) {
    const previous = motionPlan.scenes[index - 1].diagram.kind;
    const current = motionPlan.scenes[index].diagram.kind;
    if (current !== "legacy" && current === previous) throw new Error(`MotionPlan repeats ${current} in consecutive scenes`);
  }
  for (const kind of new Set(kinds)) {
    if (kinds.filter((candidate) => candidate === kind).length > 2) throw new Error(`MotionPlan uses ${kind} more than twice`);
  }
}

export function createBasicMotionPlan(videoPlan: VideoPlan): MotionPlan {
  return {
    schemaVersion: 1,
    theme: "dark-cyan-v1",
    scenes: videoPlan.scenes.map((_, sceneIndex) => ({ sceneIndex, diagram: { kind: "legacy" } }))
  };
}
