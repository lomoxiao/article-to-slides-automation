import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisPrompt, claimWebHomeworkJob, createHomeworkJobId, isHomeworkMessage, parseWebHomeworkTrigger } from "./homeworkJobService.js";

test("accepts one Slack message containing the homework prefix and files", () => {
  assert.equal(isHomeworkMessage({
    type: "message",
    text: "[homework] 小4算数",
    channel: "C123",
    ts: "1751330000.000100",
    files: [{ id: "F123", mimetype: "image/jpeg" }]
  }), true);
});

test("does not link a separate text-only message", () => {
  assert.equal(isHomeworkMessage({ type: "message", text: "[homework]", channel: "C123", ts: "1", files: undefined }), false);
});

test("creates a stable job id from message and file identity", () => {
  const input = { channel: "C123", ts: "1751330000.000100", fileId: "F123" };
  assert.equal(createHomeworkJobId(input), createHomeworkJobId(input));
  assert.match(createHomeworkJobId(input), /C123.*F123/);
});

test("analysis prompt requires a problems array with scalar fields", () => {
  const prompt = buildAnalysisPrompt();
  assert.match(prompt, /"problems"/);
  assert.match(prompt, /problemText.*単一文字列/s);
  assert.match(prompt, /最大10件/);
});


test("parses only a strict web homework trigger", () => {
  assert.equal(parseWebHomeworkTrigger("[homework-web] homework-abc_123"), "homework-abc_123");
  assert.equal(parseWebHomeworkTrigger("[homework-web] ../abc"), undefined);
  assert.equal(parseWebHomeworkTrigger("[homework] homework-abc"), undefined);
});


test("web claim retries when the transaction starts with a null cache", () => {
  assert.equal(claimWebHomeworkJob(null), null);
});

test("web claim transitions only a queued web job", () => {
  const queued = {
    id: "homework-web-1", ownerUid: "uid", status: "queued", stage: "queued",
    trigger: { provider: "web", requestedBy: "uid" }, error: "retry",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  } as const;
  const claimed = claimWebHomeworkJob(queued, "2026-01-02T00:00:00.000Z");
  assert.equal(claimed?.status, "downloading");
  assert.equal(claimed?.stage, "downloading");
  assert.equal(claimed?.updatedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(Object.hasOwn(claimed ?? {}, "error"), false);
  assert.equal(claimWebHomeworkJob({ ...queued, trigger: undefined }), undefined);
  assert.equal(claimWebHomeworkJob({ ...queued, status: "analyzing", stage: "analyzing" }), undefined);
  assert.equal(claimWebHomeworkJob({ ...queued, status: "completed", stage: "completed" }), undefined);
});
