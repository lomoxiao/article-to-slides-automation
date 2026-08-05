import assert from "node:assert/strict";
import test from "node:test";
import { createBasicMotionPlan, motionDiagramSchema, motionPlanSchema, validateMotionPlanContract } from "./motionTypes.js";
import { assertRichMotionSmokeTextPreserved, createRichMotionSmokePlan, RICH_MOTION_SMOKE_LABELS } from "./richMotionSmokeFixture.js";
import { videoPlanSchema } from "./types.js";

const item = (label: string) => ({ label, tone: "neutral" as const });
const diagrams = [
  { kind: "topology", nodes: [item("入力"), item("出力")], edges: [{ from: 0, to: 1 }] },
  { kind: "migration", before: { label: "以前", items: ["手動"] }, after: { label: "以後", items: ["自動"] } },
  { kind: "cycle", center: "循環", steps: [item("収集"), item("処理"), item("反映")] },
  { kind: "branch", source: item("要求"), paths: [item("経路A"), item("経路B")] },
  { kind: "loop", center: "再実行", steps: [item("要求"), item("応答"), item("再送")] },
  { kind: "layers", layers: [item("基礎"), item("応用")], focusIndex: 1 },
  { kind: "gates", token: "TOKEN", gates: [item("検証A"), item("検証B")], result: "許可" },
  { kind: "timeline", steps: [item("過去"), item("現在"), item("未来")] },
  { kind: "metric", value: "90%", label: "達成率" },
  { kind: "cause-effect", source: item("原因"), paths: [item("影響A"), item("影響B")] }
];

function videoPlan(sceneCount = 6) {
  return videoPlanSchema.parse({
    schemaVersion: 2, title: "テスト記事",
    scenes: Array.from({ length: sceneCount }, (_, index) => {
      const narration = String.fromCharCode(0x3042 + index).repeat(48);
      return { narration, captionPhrases: [narration.slice(0, 24), narration.slice(24)], screenText: `重要な場面${index + 1}`, supportingText: "根拠に基づいて重要な内容を分かりやすく説明します。", visual: { kind: "keypoints", items: ["要点その一", "要点その二"] }, evidence: `根拠${index + 1}` };
    })
  });
}

test("all ten rich diagram contracts are accepted", () => {
  diagrams.forEach((diagram) => assert.doesNotThrow(() => motionDiagramSchema.parse(diagram)));
});

test("rich smoke fixture keeps its UTF-8 Japanese labels", () => {
  const plan = createRichMotionSmokePlan(videoPlan(7));
  assert.equal(plan.scenes.length, 7);
  const preservedHtml = RICH_MOTION_SMOKE_LABELS.join("|");
  assert.doesNotThrow(() => assertRichMotionSmokeTextPreserved(preservedHtml));
  assert.throws(() => assertRichMotionSmokeTextPreserved(preservedHtml.replace("日本語解析", "????")), /lost UTF-8|question marks/);
});

test("diagram contracts reject invalid references, limits, and unsafe content", () => {
  assert.throws(() => motionDiagramSchema.parse({ kind: "topology", nodes: Array.from({ length: 7 }, (_, index) => item(`N${index}`)), edges: [{ from: 0, to: 1 }] }));
  assert.throws(() => motionDiagramSchema.parse({ kind: "topology", nodes: [item("A"), item("B")], edges: [{ from: 0, to: 2 }] }));
  assert.throws(() => motionDiagramSchema.parse({ kind: "metric", value: "1", label: "長".repeat(25) }));
  assert.throws(() => motionDiagramSchema.parse({ kind: "layers", layers: [item("A"), item("B")], focusIndex: 2 }));
  assert.throws(() => motionDiagramSchema.parse({ kind: "metric", value: "1", label: "<script>bad</script>" }));
  assert.throws(() => motionDiagramSchema.parse({ kind: "metric", value: "1", label: "????" }));
  assert.throws(() => motionDiagramSchema.parse({ kind: "metric", value: "1", label: "安全", html: "<b>bad</b>" }));
  assert.throws(() => motionDiagramSchema.parse({ kind: "branch", source: item("元"), paths: [item("一つだけ")] }));
});

test("rich plan enforces density, variety, ordering, and repetition", () => {
  const plan = videoPlan();
  const valid = motionPlanSchema.parse({ schemaVersion: 1, theme: "dark-cyan-v1", scenes: diagrams.slice(0, 6).map((diagram, sceneIndex) => ({ sceneIndex, diagram })) });
  assert.doesNotThrow(() => validateMotionPlanContract(valid, plan));
  const basic = createBasicMotionPlan(plan);
  assert.doesNotThrow(() => validateMotionPlanContract(basic, plan, false));
  assert.throws(() => validateMotionPlanContract(basic, plan, true), /at least 4/);
  const repeated = structuredClone(valid);
  repeated.scenes[1].diagram = repeated.scenes[0].diagram;
  assert.throws(() => validateMotionPlanContract(repeated, plan), /consecutive/);
  const unordered = structuredClone(valid);
  unordered.scenes[2].sceneIndex = 7;
  assert.throws(() => validateMotionPlanContract(unordered, plan), /sceneIndex/);
});
