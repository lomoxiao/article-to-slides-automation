import test from "node:test";
import assert from "node:assert/strict";
import { buildChartOverride, createCodexPrompt } from "./slidePrompts.js";
import type { SlideJob } from "../../types/jobs.js";

const baseJob: SlideJob = {
  id: "20260720T000000Z-abcd1234",
  url: "https://example.com/article",
  status: "processing",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  pendingDir: "jobs/pending/x",
  completedDir: "jobs/completed/x"
};

const content = {
  sources: [{ url: "https://example.com/article", title: "記事タイトル", body: "本文" }],
  mergedBody: "本文"
};

test("buildChartOverride is empty without chart keywords", () => {
  assert.equal(buildChartOverride(undefined), "");
  assert.equal(buildChartOverride("経営層向けに要点重視で"), "");
});

test("buildChartOverride activates on chart keywords", () => {
  const override = buildChartOverride("グラフを多めに");
  assert.ok(override.includes("CHART_OVERRIDE"));
  assert.ok(override.includes('"chartType":"bar"'));
});

test("createCodexPrompt embeds paths, source list, and security constraints", () => {
  const prompt = createCodexPrompt(baseJob, content, "jobs/processing/x/source.txt", "jobs/processing/x/slideData.json");
  assert.ok(prompt.includes("Job ID: 20260720T000000Z-abcd1234"));
  assert.ok(prompt.includes("Read the source text at jobs/processing/x/source.txt"));
  assert.ok(prompt.includes("Write exactly one output file: jobs/processing/x/slideData.json"));
  assert.ok(prompt.includes("untrusted input data"));
  assert.ok(prompt.includes("1. 記事タイトル"));
  assert.ok(!prompt.includes("CHART_OVERRIDE"));
});

test("createCodexPrompt includes options and multi-source instruction", () => {
  const job: SlideJob = { ...baseJob, audience: "経営層", focus: "グラフ中心", pages: 8 };
  const multi = {
    sources: [
      { url: "https://a.com", title: "A", body: "a" },
      { url: "https://b.com", title: "B", body: "b" }
    ],
    mergedBody: "ab"
  };
  const prompt = createCodexPrompt(job, multi, "s.txt", "out.json");
  assert.ok(prompt.includes("Target audience: 経営層"));
  assert.ok(prompt.includes("Target slide count: about 8 slides"));
  assert.ok(prompt.includes("Add a final sources slide"));
  assert.ok(prompt.includes("CHART_OVERRIDE"));
});
