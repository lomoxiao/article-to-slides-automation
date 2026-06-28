import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeTimeoutError } from "./claudeRunner.js";

test("ClaudeTimeoutError preserves partial process output", () => {
  const error = new ClaudeTimeoutError(240_000, "partial stdout", "partial stderr");

  assert.equal(error.name, "ClaudeTimeoutError");
  assert.equal(error.message, "claude exec timed out after 240000ms");
  assert.equal(error.timeoutMs, 240_000);
  assert.equal(error.stdout, "partial stdout");
  assert.equal(error.stderr, "partial stderr");
});
