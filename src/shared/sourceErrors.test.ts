import test from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_UNAVAILABLE_PREFIX,
  SourceUnavailableError,
  describeSourceFailure,
  isSourceUnavailableError
} from "./sourceErrors.js";

test("説明文は固定の書き出しで始まり、テキスト投入を案内する", () => {
  const message = describeSourceFailure("http_403");
  assert.ok(message.startsWith(SOURCE_UNAVAILABLE_PREFIX));
  assert.match(message, /取得を拒否/);
  assert.match(message, /テキスト投入/);
});

test("too_short は文字数、http_other はステータスを添える", () => {
  assert.match(describeSourceFailure("too_short", { chars: 37 }), /37文字/);
  assert.match(describeSourceFailure("http_other", { status: 500 }), /HTTP 500/);
});

test("未知の理由は汎用の説明になる", () => {
  assert.match(describeSourceFailure("something_new"), /取得中にエラー/);
});

test("name で見分けられる", () => {
  assert.equal(isSourceUnavailableError(new SourceUnavailableError("https://a", "timeout", "m")), true);
  assert.equal(isSourceUnavailableError(new Error("m")), false);
  assert.equal(isSourceUnavailableError("m"), false);
});
