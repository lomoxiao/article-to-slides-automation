import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEnvFile } from "./envFile.js";

const dir = await mkdtemp(path.join(tmpdir(), "envfile-test-"));

test("applyEnvFile sets values without overriding existing env", async () => {
  const envPath = path.join(dir, "a.env");
  await writeFile(
    envPath,
    ["ENVFILE_TEST_NEW=fromfile", "ENVFILE_TEST_EXISTING=fromfile"].join("\n"),
    "utf8"
  );
  process.env.ENVFILE_TEST_EXISTING = "preset";

  applyEnvFile(envPath);

  assert.equal(process.env.ENVFILE_TEST_NEW, "fromfile");
  assert.equal(process.env.ENVFILE_TEST_EXISTING, "preset");
});

test("applyEnvFile skips comments, blank lines, and lines without separator", async () => {
  const envPath = path.join(dir, "b.env");
  await writeFile(
    envPath,
    ["# comment", "", "NOSEPARATOR", "ENVFILE_TEST_TRIM = padded value "].join("\r\n"),
    "utf8"
  );

  applyEnvFile(envPath);

  assert.equal("NOSEPARATOR" in process.env, false);
  assert.equal(process.env.ENVFILE_TEST_TRIM, "padded value");
});

test("applyEnvFile is a no-op for a missing file", () => {
  assert.doesNotThrow(() => applyEnvFile(path.join(dir, "does-not-exist.env")));
});
