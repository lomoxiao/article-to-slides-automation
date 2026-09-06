import test from "node:test";
import assert from "node:assert/strict";
import {
  parseReaderRefreshArgs,
  READER_REFRESH_USAGE
} from "./readerRefreshOptions.js";

test("updateはFirebase更新モードになる", () => {
  assert.deepEqual(parseReaderRefreshArgs(["update", "https://example.com/article"]), {
    url: "https://example.com/article",
    mode: "update"
  });
});

test("previewは外部状態を更新しない確認モードになる", () => {
  assert.deepEqual(
    parseReaderRefreshArgs(["preview", "https://example.com/article"]),
    {
      url: "https://example.com/article",
      mode: "preview"
    }
  );
});

test("sendはFirebase更新とInstapaper再送信を有効にする", () => {
  assert.deepEqual(
    parseReaderRefreshArgs(["send", "https://example.com/article"]),
    {
      url: "https://example.com/article",
      mode: "send"
    }
  );
});

test("未対応モード、モードなし、引数過多を拒否する", () => {
  assert.throws(
    () => parseReaderRefreshArgs(["--preview", "https://example.com"]),
    /Unsupported mode/
  );
  assert.throws(
    () => parseReaderRefreshArgs(["https://example.com"]),
    new RegExp(READER_REFRESH_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
  assert.throws(
    () => parseReaderRefreshArgs(["preview", "https://example.com", "extra"]),
    new RegExp(READER_REFRESH_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("HTTP(S)以外のURLを拒否する", () => {
  assert.throws(
    () => parseReaderRefreshArgs(["preview", "file:///tmp/article.html"]),
    /must use http or https/
  );
});
