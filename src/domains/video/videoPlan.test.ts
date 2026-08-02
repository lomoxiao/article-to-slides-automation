import assert from "node:assert/strict";
import test from "node:test";
import { videoPlanSchema, visualSpecSchema } from "./types.js";
import { deriveCaptionPhrases, outputSchema, repairEvidenceQuote, targetNarrationCharacters, validateVideoPlanContract } from "./videoPlan.js";

test("Codex output schema gives every single-value enum an explicit type", () => {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.enum) && record.enum.length === 1) assert.equal(typeof record.type, "string");
    Object.values(record).forEach(visit);
  };
  visit(outputSchema);
});

function phrases(value: string): string[] {
  const midpoint = Math.floor(value.length / 2);
  return [value.slice(0, midpoint), value.slice(midpoint)];
}

function planWith(charsPerScene: number) {
  return videoPlanSchema.parse({
    schemaVersion: 2,
    title: "記事解説",
    scenes: Array.from({ length: 6 }, (_, index) => {
      const narration = String.fromCharCode(0x3042 + index).repeat(charsPerScene);
      return {
        narration,
        captionPhrases: phrases(narration),
        screenText: `重要な要点${index + 1}`,
        supportingText: `記事の根拠から要点${index + 1}を分かりやすく説明します`,
        visual: index === 0
          ? { kind: "title", keywords: ["記事", "要点"] }
          : { kind: "keypoints", items: ["重要な事実", "実務への影響"] },
        evidence: `根拠${index + 1}`
      };
    })
  });
}

const source = "根拠1 根拠2 根拠3 根拠4 根拠5 根拠6";

test("Codex output schema enforces the caption phrase minimum length", () => {
  const schema = outputSchema as { properties: { scenes: { items: { properties: { captionPhrases: { items: { minLength: number } } } } } } };
  assert.equal(schema.properties.scenes.items.properties.captionPhrases.items.minLength, 8);
});

test("caption repair slices narration at meaningful boundaries without changing text", () => {
  const narration = "これは最初の要点です。次に重要な違いを説明します。そして最後に結論をまとめます。";
  const phrases = deriveCaptionPhrases(narration, ["これは最初の要点です。", "次に重要な差を説明します。", "最後に結論です。"]);
  assert.equal(phrases.join(""), narration);
  assert.ok(phrases.every((phrase) => phrase.length >= 8 && phrase.length <= 32));
  assert.equal(phrases[0], "これは最初の要点です。");
});

test("evidence repair maps a minor transcription error back to an exact source quote", () => {
  const source = "優勝すれば世界一になれるっていうまさに ビートボックス界の世界大会です。";
  const proposed = "優勝すれば世界一になれるっていうまさにビートボックス会の世界大会です。";
  const repaired = repairEvidenceQuote(proposed, source);
  assert.ok(repaired);
  assert.ok(source.includes(repaired));
  assert.equal(repaired, source);
});

test("initial VideoPlan v2 enforces narration and caption contracts", () => {
  assert.doesNotThrow(() => validateVideoPlanContract(planWith(48), source));
  assert.throws(() => validateVideoPlanContract(planWith(40), source), /280-340/);
  const invalid = structuredClone(planWith(48));
  invalid.scenes[0].captionPhrases[0] = "一致しない字幕です";
  assert.throws(() => videoPlanSchema.parse(invalid), /concatenate/);
});

test("all fixed visual card variants are accepted", () => {
  const variants = [
    { kind: "title", keywords: ["記事", "解説"] },
    { kind: "keypoints", items: ["要点一", "要点二"] },
    { kind: "steps", items: ["手順一", "手順二"] },
    { kind: "summary", items: ["結論一", "結論二"] },
    { kind: "compare", left: { label: "導入前", items: ["手作業"] }, right: { label: "導入後", items: ["自動化"] } },
    { kind: "number", value: "60秒", label: "動画の目標時間" },
    { kind: "quote", text: "記事から引用した重要な一文です" }
  ];
  variants.forEach((variant) => assert.doesNotThrow(() => visualSpecSchema.parse(variant)));
  assert.throws(() => visualSpecSchema.parse({ kind: "steps", items: ["一つだけ"] }));
  assert.throws(() => visualSpecSchema.parse({ kind: "quote", text: "<script>危険</script>" }));
});

test("duration recovery clamps the character target to 240-380", () => {
  const plan = planWith(48);
  assert.equal(targetNarrationCharacters(plan, 120), 240);
  assert.equal(targetNarrationCharacters(plan, 30), 380);
  assert.equal(targetNarrationCharacters(plan, 60), 288);
});

test("duration recovery may change narration and captions only", () => {
  const previous = planWith(48);
  const recovered = structuredClone(previous);
  recovered.scenes.forEach((scene) => {
    scene.narration = scene.narration.slice(0, 45);
    scene.captionPhrases = phrases(scene.narration);
  });
  assert.doesNotThrow(() => validateVideoPlanContract(recovered, source, previous));
  recovered.scenes[0].supportingText = "この変更は画面表示の契約を変えてしまうため許可されません";
  assert.throws(() => validateVideoPlanContract(recovered, source, previous), /display metadata/);
});

test("evidence must be an exact source substring", () => {
  const plan = planWith(48);
  plan.scenes[2].evidence = "存在しない根拠";
  assert.throws(() => validateVideoPlanContract(plan, source), /not present/);
});
