import assert from "node:assert/strict";
import test from "node:test";
import { AsyncSemaphore, claudeExecSemaphore, codexExecSemaphore, resourceIntensiveSemaphore } from "./resourceSemaphore.js";

test("resource intensive manga/video tasks are process-wide exclusive", async () => {
  let active = 0;
  let maxActive = 0;
  const run = () => resourceIntensiveSemaphore.runExclusive(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  });
  await Promise.all([run(), run(), run()]);
  assert.equal(maxActive, 1);
});

test("AI実行用の順番待ちは1件ずつ、依頼順に進む", async () => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const run = (label: string) => codexExecSemaphore.runExclusive(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`end:${label}`);
    active -= 1;
  });
  await Promise.all([run("a"), run("b"), run("c")]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
});

test("重い処理用とAI実行用は別の順番待ちで、重い処理の中からAIを呼んでも固まらない", async () => {
  assert.notEqual(codexExecSemaphore, resourceIntensiveSemaphore);
  assert.notEqual(codexExecSemaphore, claudeExecSemaphore);
  const result = await resourceIntensiveSemaphore.runExclusive(() => codexExecSemaphore.runExclusive(async () => "ok"));
  assert.equal(result, "ok");
});

test("処理が失敗しても順番待ちは次へ進む", async () => {
  const semaphore = new AsyncSemaphore();
  await assert.rejects(semaphore.runExclusive(async () => { throw new Error("boom"); }));
  assert.equal(await semaphore.runExclusive(async () => 1), 1);
});
