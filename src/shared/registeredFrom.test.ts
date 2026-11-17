import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSaveOrigin } from "./registeredFrom.js";

test("保存元: 知っている値だけを通し、それ以外は shortcut に丸める", () => {
  assert.equal(normalizeSaveOrigin("bookmarklet"), "bookmarklet");
  assert.equal(normalizeSaveOrigin(" Shortcut "), "shortcut");
  assert.equal(normalizeSaveOrigin(undefined), "shortcut");
  assert.equal(normalizeSaveOrigin(""), "shortcut");
  assert.equal(normalizeSaveOrigin("daily-digest"), "shortcut");
  assert.equal(normalizeSaveOrigin("bundle"), "shortcut");
});
