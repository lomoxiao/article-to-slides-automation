import test from "node:test";
import assert from "node:assert/strict";
import { artifactUrl, classifyArtifactItem, diffNewArtifacts } from "./notebookLmDriver.js";

const NOTEBOOK_ID = "0b7d8a1c-1111-4222-8333-444455556666";
const ARTIFACT_A = "aaaaaaaa-1111-4222-8333-444455556666";
const ARTIFACT_B = "bbbbbbbb-1111-4222-8333-444455556666";

test("diffNewArtifacts returns only artifacts absent from the before snapshot", () => {
  const after = [
    { id: ARTIFACT_B, text: "新しいデック" },
    { id: ARTIFACT_A, text: "古いデック" },
    { id: null, text: "ID不明の項目" }
  ];

  const diff = diffNewArtifacts([ARTIFACT_A], after);

  assert.deepEqual(diff, [{ id: ARTIFACT_B, text: "新しいデック" }]);
});

test("diffNewArtifacts compares IDs case-insensitively", () => {
  const after = [{ id: ARTIFACT_A.toUpperCase(), text: "既存" }];

  assert.deepEqual(diffNewArtifacts([ARTIFACT_A], after), []);
});

test("diffNewArtifacts with empty before returns all identified artifacts", () => {
  const after = [
    { id: ARTIFACT_A, text: "a" },
    { id: null, text: "b" }
  ];

  assert.deepEqual(diffNewArtifacts([], after), [{ id: ARTIFACT_A, text: "a" }]);
});

test("classifyArtifactItem detects generating state", () => {
  assert.equal(classifyArtifactItem({ id: ARTIFACT_A, text: "スライドデックを生成中..." }), "generating");
  assert.equal(classifyArtifactItem({ id: ARTIFACT_A, text: "作成中です" }), "generating");
});

test("classifyArtifactItem detects generation failure over generating text", () => {
  assert.equal(classifyArtifactItem({ id: ARTIFACT_A, text: "生成に失敗しました(生成中に中断)" }), "generation_failed");
  assert.equal(classifyArtifactItem({ id: ARTIFACT_A, text: "生成エラー" }), "generation_failed");
});

test("classifyArtifactItem treats other text as ready", () => {
  assert.equal(classifyArtifactItem({ id: ARTIFACT_A, text: "漫画デック 12スライド" }), "ready");
});

test("artifactUrl builds the shareable base URL", () => {
  assert.equal(
    artifactUrl(NOTEBOOK_ID, ARTIFACT_A),
    `https://notebooklm.google.com/notebook/${NOTEBOOK_ID}/artifact/${ARTIFACT_A}`
  );
});
