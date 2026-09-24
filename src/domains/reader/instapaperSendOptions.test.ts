import test from "node:test";
import assert from "node:assert/strict";
import { parseInstapaperSendArgs } from "./instapaperSendOptions.js";

test("requires an explicit mode", () => {
  assert.throws(() => parseInstapaperSendArgs(["--file", "a.md"]), /Mode must be preview or send/);
});

test("parses a vault artifact send", () => {
  const options = parseInstapaperSendArgs([
    "send",
    "--vault-artifact",
    "D:/work/brain/projects/payments-weekly/artifacts/report.md"
  ]);
  assert.equal(options.mode, "send");
  assert.equal(options.origin, "vault-artifact");
  assert.equal(options.path, "D:/work/brain/projects/payments-weekly/artifacts/report.md");
});

test("parses stdin with a title and inline value syntax", () => {
  const options = parseInstapaperSendArgs(["preview", "--stdin", "--title=調査結果"]);
  assert.equal(options.origin, "stdin");
  assert.equal(options.title, "調査結果");
});

test("rejects more than one source", () => {
  assert.throws(
    () => parseInstapaperSendArgs(["send", "--file", "a.md", "--stdin"]),
    /Choose exactly one/
  );
});

test("rejects a missing source", () => {
  assert.throws(() => parseInstapaperSendArgs(["send"]), /Choose exactly one/);
});

test("rejects a non-http source url", () => {
  assert.throws(
    () => parseInstapaperSendArgs(["send", "--file", "a.md", "--url", "javascript:alert(1)"]),
    /--url must be http or https/
  );
});

test("rejects a flag that is missing its value", () => {
  assert.throws(
    () => parseInstapaperSendArgs(["send", "--file", "--title", "x"]),
    /Choose exactly one|requires a value/
  );
});
