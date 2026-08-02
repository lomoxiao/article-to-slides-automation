import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("legacy CLI finalizer is explicit, local-only, and preserves artifacts", async () => {
  const [source, packageJson] = await Promise.all([
    readFile("src/scripts/finalizeLegacyCliVideoJobs.ts", "utf8"),
    readFile("package.json", "utf8"),
  ]);
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;

  assert.match(source, /job\.requestedBy === "cli"/);
  assert.match(source, /process\.argv\.includes\("--apply"\)/);
  assert.match(source, /validateFinalVideo\(outputPath\)/);
  assert.doesNotMatch(source, /unlink|rm\(|rmdir|Drive|writeVideoState/);
  assert.equal(scripts["video:jobs:finalize-cli"], "tsx src/scripts/finalizeLegacyCliVideoJobs.ts");
  assert.equal(scripts["video:jobs:finalize-cli:apply"], "tsx src/scripts/finalizeLegacyCliVideoJobs.ts --apply");
});
