import test from "node:test";
import assert from "node:assert/strict";
import { clampSvgSize, createSvgRenderHtml, parseSvgSize } from "./chartSvg.js";

test("parseSvgSize uses width/height attributes", () => {
  assert.deepEqual(parseSvgSize('<svg width="640" height="360"></svg>'), { width: 640, height: 360 });
});

test("parseSvgSize handles px units and fractions by ceiling", () => {
  assert.deepEqual(parseSvgSize('<svg width="640.2px" height="359.5px"></svg>'), { width: 641, height: 360 });
});

test("parseSvgSize falls back to viewBox", () => {
  assert.deepEqual(parseSvgSize('<svg viewBox="0 0 1200 630"></svg>'), { width: 1200, height: 630 });
});

test("parseSvgSize returns the default when nothing is parseable", () => {
  assert.deepEqual(parseSvgSize("<svg></svg>"), { width: 800, height: 600 });
});

test("clampSvgSize clamps to the max viewport and floors at 1", () => {
  assert.deepEqual(clampSvgSize(10_000, 0.4), { width: 4096, height: 1 });
});

test("createSvgRenderHtml embeds the svg and the ready flag script", () => {
  const html = createSvgRenderHtml('<svg width="10" height="10"></svg>');
  assert.ok(html.includes('<svg width="10" height="10"></svg>'));
  assert.ok(html.includes("__svgRenderReady"));
});
