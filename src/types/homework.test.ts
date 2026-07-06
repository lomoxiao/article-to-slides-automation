import test from "node:test";
import assert from "node:assert/strict";
import { homeworkAnalysisSchema } from "./homework.js";

const problem = {
  id: "基本2",
  problemText: "黄色をもとにすると赤は何倍ですか。",
  studentAnswer: "6.12倍",
  correctAnswerCandidate: "0.72倍",
  mistakeCause: "小数の割り算を誤った可能性がある。",
  confidence: { problemText: 0.9, studentAnswer: 0.7, correctAnswerCandidate: 0.9, mistakeCause: 0.6 },
  evidence: ["答案の書き込み"],
  warnings: []
};

test("accepts one or more separated homework problems", () => {
  const result = homeworkAnalysisSchema.parse({ problems: [problem, { ...problem, id: "基本3" }], warnings: [], needsHumanReview: true });
  assert.equal(result.problems.length, 2);
});

test("rejects arrays and objects in scalar problem fields", () => {
  const result = homeworkAnalysisSchema.safeParse({ problems: [{ ...problem, problemText: ["問1", "問2"], studentAnswer: { value: "1" } }], warnings: [], needsHumanReview: true });
  assert.equal(result.success, false);
});

test("keeps at most ten candidates and adds a warning", () => {
  const problems = Array.from({ length: 12 }, (_, index) => ({ ...problem, id: `problem-${index + 1}` }));
  const result = homeworkAnalysisSchema.parse({ problems, warnings: [], needsHumanReview: true });
  assert.equal(result.problems.length, 10);
  assert.match(result.warnings[0], /10件/);
});
