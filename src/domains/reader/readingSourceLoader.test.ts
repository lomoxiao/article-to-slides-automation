import test from "node:test";
import assert from "node:assert/strict";
import {
  assertVaultArtifactPath,
  loadReadingSource,
  ReadingSourcePolicyError
} from "./readingSourceLoader.js";

const fixedNow = () => new Date("2026-09-12T13:00:00.000Z");

function fakeReader(content: string) {
  return (async () => content) as unknown as typeof import("node:fs/promises").readFile;
}

test("loads a vault artifact and derives the title from the heading", async () => {
  const source = await loadReadingSource(
    {
      origin: "vault-artifact",
      path: "/vault/projects/payments-weekly/artifacts/report.md",
      now: fixedNow
    },
    fakeReader('---\ndate: "2026-09-12"\n---\n\n# 金融決済ウィークリー 第2回\n\n本文 [[projects/x/evidence/abc]]。')
  );
  assert.equal(source.title, "金融決済ウィークリー 第2回");
  assert.equal(source.origin, "vault-artifact");
  assert.equal(source.richText, true);
  assert.match(source.markdown, /（出典: abc）/);
  assert.equal(source.key, "/vault/projects/payments-weekly/artifacts/report.md");
  assert.equal(source.sourceUrl, undefined);
});

test("rejects evidence files and anything outside artifacts", () => {
  assert.throws(
    () => assertVaultArtifactPath("/vault/projects/payments-weekly/evidence/note.md"),
    ReadingSourcePolicyError
  );
  assert.throws(
    () => assertVaultArtifactPath("/vault/projects/payments-weekly/log.md"),
    ReadingSourcePolicyError
  );
  assert.doesNotThrow(() =>
    assertVaultArtifactPath("/vault/projects/payments-weekly/artifacts/report.md")
  );
});

test("accepts arbitrary markdown files without the vault policy", async () => {
  const source = await loadReadingSource(
    { origin: "markdown-file", path: "/tmp/research-notes.md", now: fixedNow },
    fakeReader("# 調査メモ\n\n内容")
  );
  assert.equal(source.title, "調査メモ");
  assert.equal(source.origin, "markdown-file");
});

test("accepts inline text from a conversation with an explicit title", async () => {
  const source = await loadReadingSource({
    origin: "inline",
    text: "## 調査結果\n\n本文です。",
    title: "GPT-6 Astra の評判",
    key: "chat:2026-09-12-astra",
    now: fixedNow
  });
  assert.equal(source.title, "GPT-6 Astra の評判");
  assert.equal(source.key, "chat:2026-09-12-astra");
  assert.equal(source.capturedAt, "2026-09-12T13:00:00.000Z");
});

test("falls back to the file name when there is no heading", async () => {
  const source = await loadReadingSource(
    { origin: "markdown-file", path: "/tmp/2026-09-12-notes.md", now: fixedNow },
    fakeReader("本文だけのメモ")
  );
  assert.equal(source.title, "2026-09-12-notes");
});

test("refuses an empty body", async () => {
  await assert.rejects(
    loadReadingSource({ origin: "inline", text: "   ", title: "空" }),
    /requires text/
  );
});
