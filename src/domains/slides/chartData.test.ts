import test from "node:test";
import assert from "node:assert/strict";
import { collectChartTargets, parseChartImage, validateChartImage } from "./chartData.js";

const validBar = {
  chartType: "bar",
  data: {
    items: [{ label: "A", value: 1 }],
    color: { start: "#111111", end: "#222222" },
    layout: { width: 800, height: 600, marginTop: 10, marginBottom: 10, marginLeft: 10, marginRight: 10 },
    barOptions: { barToSlotRatio: 0.6 },
    yAxis: { max: 10, min: 0, tickCount: 5 }
  }
};

test("collectChartTargets picks chart JSON strings and keeps their key", () => {
  const targets = collectChartTargets([
    { title: "no image" },
    { image: JSON.stringify(validBar) },
    { image: "https://example.com/photo.png" }
  ]);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].slideIndex, 1);
  assert.equal(targets[0].chartType, "bar");
  assert.equal(targets[0].key, JSON.stringify(validBar));
});

test("parseChartImage skips already-rendered chart PNGs", () => {
  const rendered = { info: "chart", data: "data:image/png;base64,xxxx" };
  assert.equal(parseChartImage(rendered), undefined);
});

test("parseChartImage accepts an object payload with a stable key", () => {
  const parsed = parseChartImage(validBar);
  assert.ok(parsed);
  assert.equal(parsed.chartType, "bar");
  assert.equal(parsed.key, JSON.stringify(validBar));
});

test("validateChartImage accepts a valid bar payload", () => {
  assert.doesNotThrow(() => validateChartImage(validBar, 0));
});

test("validateChartImage rejects an unsupported chartType", () => {
  assert.throws(
    () => validateChartImage({ chartType: "pie", data: {} }, 0),
    /unsupported chartType/
  );
});

test("validateChartImage rejects legacy non-Majin keys", () => {
  const legacy = structuredClone(validBar) as { chartType: string; data: Record<string, unknown> };
  legacy.data.xKey = "label";
  assert.throws(() => validateChartImage(legacy, 2), /unsupported data\.xKey/);
});

test("validateChartImage reports missing fields with their path", () => {
  const broken = structuredClone(validBar) as { chartType: string; data: Record<string, unknown> };
  delete broken.data.yAxis;
  assert.throws(() => validateChartImage(broken, 0), /missing data\.yAxis/);
});

test("validateChartImage rejects multi-line series length mismatch", () => {
  const multiLine = {
    chartType: "multi-line",
    data: {
      xAxisLabels: ["1月", "2月"],
      series: [{ id: "s1", label: "系列1", values: [1] }],
      colors: [{ id: "s1", start: "#111111", end: "#222222" }],
      yAxis: { max: 10, min: 0, tickCount: 5 }
    }
  };
  assert.throws(() => validateChartImage(multiLine, 0), /values must match data\.xAxisLabels\.length/);
});

test("validateChartImage rejects items whose id has no matching color", () => {
  const donut = {
    chartType: "donut",
    data: {
      centerLabel: "合計",
      items: [{ label: "A", value: 1, id: "missing" }],
      colors: [{ id: "a", start: "#111111", end: "#222222" }]
    }
  };
  assert.throws(() => validateChartImage(donut, 0), /does not match any data\.colors/);
});
