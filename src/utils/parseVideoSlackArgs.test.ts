import assert from "node:assert/strict";
import test from "node:test";
import { parseVideoSlackArgs } from "./parseVideoSlackArgs.js";

test("video Slack parser accepts one URL and optional audience/focus", () => {
  assert.deepEqual(parseVideoSlackArgs('[video-generate] --url "https://example.com/a" --audience "初心者" --focus "料金"'), {
    ok: true, url: "https://example.com/a", audience: "初心者", focus: "料金"
  });
});

test("video Slack parser rejects missing, multiple, and unsupported input", () => {
  assert.equal(parseVideoSlackArgs("[video-generate]").ok, false);
  assert.equal(parseVideoSlackArgs("[video-generate] https://a.example https://b.example").ok, false);
  assert.equal(parseVideoSlackArgs("[video-generate] --pages 6 https://a.example").ok, false);
});
