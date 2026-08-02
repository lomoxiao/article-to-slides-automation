import assert from "node:assert/strict";
import test from "node:test";
import { generationRequestSchema } from "./generationRequestWatcher.js";

const base = {
  ownerUid: "user",
  kind: "text",
  text: "記事本文",
  status: "queued",
  createdAt: "2026-08-02T00:00:00.000Z",
  trigger: { provider: "web" }
};

test("generation request permits every single and combined artifact selection", () => {
  const options = { artStyle: "A", treatment: "B" };
  for (const selection of [
    { slides: true },
    { video: true },
    { manga: true, mangaOptions: options },
    { slides: true, video: true },
    { slides: true, manga: true, video: true, mangaOptions: options }
  ]) {
    assert.equal(generationRequestSchema.safeParse({ ...base, ...selection }).success, true);
  }
});

test("generation request rejects empty/nonboolean selections and inconsistent mangaOptions", () => {
  for (const selection of [
    {},
    { slides: false, manga: false, video: false },
    { slides: "true" },
    { manga: true },
    { video: true, manga: false, mangaOptions: { artStyle: "A", treatment: "B" } }
  ]) {
    assert.equal(generationRequestSchema.safeParse({ ...base, ...selection }).success, false);
  }
});
