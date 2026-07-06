import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexExecArgs } from "./codexRunner.js";

test("uses explicit workspace sandbox without deprecated full-auto", () => {
  const args = buildCodexExecArgs({}, "last-message.txt");
  assert.equal(args.includes("--full-auto"), false);
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
});
test("adds output schema only when requested", () => {
  assert.equal(buildCodexExecArgs({}, "out").includes("--output-schema"), false);
  const args = buildCodexExecArgs({ outputSchemaPath: "schema.json" }, "out");
  assert.deepEqual(args.slice(args.indexOf("--output-schema"), args.indexOf("--output-schema") + 2), ["--output-schema", "schema.json"]);
});
