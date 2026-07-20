import test from "node:test";
import assert from "node:assert/strict";
import { spawnCli } from "./cliProcess.js";

// 実プロセスとして node 自身を使う(クロスプラットフォームで確実に存在するため)。
const node = process.execPath;

test("spawnCli captures stdout and exit code", async () => {
  const result = await spawnCli(node, ["-e", "process.stdout.write('hello'); process.exit(3)"], {
    timeoutMs: 30_000
  });

  assert.equal(result.stdout, "hello");
  assert.equal(result.exitCode, 3);
});

test("spawnCli pipes stdin to the child process", async () => {
  const result = await spawnCli(node, ["-e", "process.stdin.pipe(process.stdout)"], {
    stdin: "from-stdin",
    timeoutMs: 30_000
  });

  assert.equal(result.stdout, "from-stdin");
  assert.equal(result.exitCode, 0);
});

test("spawnCli captures stderr separately", async () => {
  const result = await spawnCli(node, ["-e", "process.stderr.write('oops')"], {
    timeoutMs: 30_000
  });

  assert.equal(result.stderr, "oops");
  assert.equal(result.stdout, "");
});

test("spawnCli rejects with the custom timeout error carrying partial output", async () => {
  await assert.rejects(
    spawnCli(node, ["-e", "process.stdout.write('partial'); setTimeout(() => {}, 60_000)"], {
      timeoutMs: 1_000,
      timeoutError: ({ stdout }) => new Error(`timed out with: ${stdout}`)
    }),
    /timed out with: partial/
  );
});

test("spawnCli rejects with a generic error when timeoutError is not given (killTree path)", async () => {
  await assert.rejects(
    spawnCli(node, ["-e", "setTimeout(() => {}, 60_000)"], {
      timeoutMs: 1_000,
      killTree: true
    }),
    /timed out after 1000ms/
  );
});

test("spawnCli rejects when the command does not exist", async () => {
  await assert.rejects(
    spawnCli("definitely-not-a-real-command-xyz", [], { timeoutMs: 5_000 })
  );
});
