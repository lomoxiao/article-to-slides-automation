import test from "node:test";
import assert from "node:assert/strict";
import { getSlideDataHeadline, getSlideDataTitle, normalizeTldr } from "./slideDataMeta.js";

test("getSlideDataTitle returns the first non-empty title", () => {
  assert.equal(getSlideDataTitle([{ type: "cover" }, { title: "  記事タイトル  " }]), "記事タイトル");
  assert.equal(getSlideDataTitle([{ title: "" }]), undefined);
});

test("getSlideDataHeadline prefers subhead and truncates to 180 chars", () => {
  assert.equal(getSlideDataHeadline([{ subhead: "見出し", subtitle: "副題" }]), "見出し");
  assert.equal(getSlideDataHeadline([{ subtitle: "副題" }]), "副題");
  const long = "あ".repeat(200);
  const headline = getSlideDataHeadline([{ notes: long }]);
  assert.ok(headline);
  assert.equal(headline.length, 182);
  assert.ok(headline.endsWith("..."));
});

test("normalizeTldr keeps only bullet lines, normalizes markers, caps at 3", () => {
  const raw = ["前置きテキスト", "- 一行目", "・二行目", "• 三行目", "- 四行目"].join("\n");
  assert.equal(normalizeTldr(raw), "- 一行目\n- 二行目\n- 三行目");
});

test("normalizeTldr returns empty string when no bullets exist", () => {
  assert.equal(normalizeTldr("要約できませんでした"), "");
});
