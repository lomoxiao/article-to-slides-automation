import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production video generation and standard preflight do not depend on Whisper", async () => {
  const files = await Promise.all([
    readFile(new URL("./videoPipeline.ts", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/videoPreflight.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../../.env.example", import.meta.url), "utf8")
  ]);
  for (const content of files) {
    assert.doesNotMatch(content, /whisper|large-v3|transcript\.json/i);
  }
});
