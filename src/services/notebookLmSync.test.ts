import test from "node:test";
import assert from "node:assert/strict";
import { classifyNotebookLmSyncResult } from "./notebookLmSync.js";

const noop = () => {};
const stdoutPath = "jobs/manga/example/claude-notebooklm-stdout.json";

test("classifies NOTEBOOKLM_DONE as executed", () => {
  const result = classifyNotebookLmSyncResult(noop, "生成を開始しました。\nNOTEBOOKLM_DONE", stdoutPath);

  assert.deepEqual(result, { status: "executed", detail: "NOTEBOOKLM_DONE" });
});

test("classifies NOTEBOOKLM_FAILED marker as failed", () => {
  const result = classifyNotebookLmSyncResult(noop, "NOTEBOOKLM_FAILED: 未ログインです", stdoutPath);

  assert.deepEqual(result, { status: "failed", detail: "NOTEBOOKLM_FAILED: 未ログインです" });
});

test("classifies NotebookLM unavailable response as failed even with DONE marker", () => {
  const result = classifyNotebookLmSyncResult(
    noop,
    "NotebookLM から「現在、回答できません。」という返信が表示されました。\nNOTEBOOKLM_DONE",
    stdoutPath
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail, /^NOTEBOOKLM_FAILED: NotebookLM が回答不能応答を返しました/);
});

test("classifies missing marker as failed", () => {
  const result = classifyNotebookLmSyncResult(noop, "生成開始を確認しました。", stdoutPath);

  assert.equal(result.status, "failed");
  assert.match(result.detail, /マーカー行なし/);
});
