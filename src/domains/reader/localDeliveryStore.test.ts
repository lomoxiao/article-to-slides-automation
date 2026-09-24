import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalDeliveryStore, hashKey } from "./localDeliveryStore.js";

const now = () => new Date("2026-09-12T13:00:00.000Z");

test("round-trips a record through the json file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "store-"));
  const file = join(dir, "state", "deliveries.json");
  const store = createLocalDeliveryStore(file, now);

  assert.equal(await store.get("artifact-a"), undefined);
  await store.put("artifact-a", { status: "completed", contentHash: "abc", bookmarkId: "1" });

  const record = await store.get("artifact-a");
  assert.equal(record?.status, "completed");
  assert.equal(record?.bookmarkId, "1");
  assert.equal(record?.updatedAt, "2026-09-12T13:00:00.000Z");
});

test("does not persist the raw key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "store-"));
  const file = join(dir, "deliveries.json");
  const store = createLocalDeliveryStore(file, now);
  await store.put("D:/private/report.md", { status: "completed", contentHash: "abc" });

  const raw = await readFile(file, "utf8");
  assert.doesNotMatch(raw, /private/);
  assert.match(raw, new RegExp(hashKey("D:/private/report.md")));
});

test("treats a corrupted store as empty instead of failing the send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "store-"));
  const file = join(dir, "deliveries.json");
  await writeFile(file, "{ not json", "utf8");
  const store = createLocalDeliveryStore(file, now);
  assert.equal(await store.get("anything"), undefined);
  await store.put("anything", { status: "completed", contentHash: "x" });
  assert.equal((await store.get("anything"))?.contentHash, "x");
});
