import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptionCue, VideoPlan, VisualSpec } from "./types.js";

export async function createHyperframesProject(input: {
  projectDir: string;
  plan: VideoPlan;
  sceneDurations: number[];
  captions: CaptionCue[];
  narrationPath: string;
}): Promise<{ sceneStarts: number[]; sceneMidpoints: number[]; durationSec: number }> {
  const assetsDir = path.join(input.projectDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await Promise.all([
    copyFile(input.narrationPath, path.join(assetsDir, "narration.wav")),
    copyFile(path.resolve("node_modules", "gsap", "dist", "gsap.min.js"), path.join(assetsDir, "gsap.min.js")),
    copyFile(path.resolve("assets", "video", "NotoSansJP.ttf"), path.join(assetsDir, "NotoSansJP.ttf")),
    copyFile(path.resolve("assets", "video", "OFL.txt"), path.join(assetsDir, "OFL.txt"))
  ]);

  const timeline = calculateSceneTimeline(input.sceneDurations);
  const starts = timeline.sceneStarts;
  const durationSec = timeline.durationSec;
  const midpoints = timeline.sceneMidpoints;
  const scenes = input.plan.scenes.map((scene, index) =>
    renderScene(scene.screenText, scene.supportingText, scene.visual, index, starts[index], input.sceneDurations[index])
  ).join("");
  const captions = input.captions.map((cue) => renderCaption(cue, durationSec)).join("");

  const html = `<!doctype html>
<html lang="ja" data-resolution="landscape"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=1920,height=1080">
<script src="./assets/gsap.min.js"></script>
<style>
@font-face{font-family:NotoSansJP;src:url("./assets/NotoSansJP.ttf") format("truetype");font-weight:100 900;font-display:block}
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#08121f;color:#f7fbff}
body{font-family:NotoSansJP,sans-serif}.scene{position:absolute;inset:0}.scene-content{position:absolute;inset:0;padding:92px 112px 184px;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(540px,.92fr);gap:72px;align-items:center;opacity:0;background:radial-gradient(circle at 82% 18%,rgba(62,214,185,.18),transparent 34%),linear-gradient(135deg,#07111f,#10263a)}
.copy{min-width:0}.kicker{color:#52e0c4;font-size:25px;letter-spacing:.14em;font-weight:700}.headline{font-size:68px;line-height:1.22;font-weight:850;margin-top:24px;max-width:1040px;text-wrap:balance;overflow-wrap:anywhere}.headline.compact{font-size:59px}.headline.tight{font-size:52px}
.supporting{margin-top:30px;max-width:970px;color:#c2d2de;font-size:31px;line-height:1.55;font-weight:500;text-wrap:balance}.counter{margin-top:30px;color:#8099ac;font-size:23px;letter-spacing:.08em}
.visual-card{width:100%;height:550px;border:2px solid rgba(82,224,196,.48);border-radius:44px;padding:42px;background:linear-gradient(155deg,rgba(13,38,56,.96),rgba(7,21,35,.92));box-shadow:0 32px 90px rgba(0,0,0,.34);display:flex;flex-direction:column;justify-content:center;overflow:hidden}
.visual-head{display:flex;align-items:center;gap:18px;color:#52e0c4;font-size:22px;font-weight:800;letter-spacing:.1em;margin-bottom:26px}.visual-icon{width:44px;height:44px;flex:none}.visual-icon circle,.visual-icon path,.visual-icon polyline{fill:none;stroke:#52e0c4;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.keyword-list{display:flex;flex-wrap:wrap;gap:18px}.keyword{padding:18px 24px;border-radius:999px;background:rgba(82,224,196,.12);border:1px solid rgba(82,224,196,.5);font-size:30px;font-weight:750}
.visual-list{display:grid;gap:17px;margin:0;padding:0;list-style:none}.visual-list li{display:flex;align-items:flex-start;gap:16px;padding:17px 20px;border-radius:20px;background:rgba(255,255,255,.055);font-size:28px;line-height:1.35;font-weight:650}.bullet{color:#52e0c4;font-weight:900;min-width:34px}
.compare-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.compare-side{padding:22px;border-radius:24px;background:rgba(255,255,255,.055);min-width:0}.compare-label{color:#52e0c4;font-size:24px;font-weight:800;margin-bottom:14px}.compare-item{font-size:24px;line-height:1.4;padding:9px 0;border-top:1px solid rgba(255,255,255,.1)}
.number-value{color:#52e0c4;font-size:104px;line-height:1;font-weight:900;letter-spacing:-.04em;overflow-wrap:anywhere}.number-label{font-size:31px;line-height:1.4;margin-top:24px;font-weight:700}.quote-text{font-size:34px;line-height:1.6;font-weight:700;text-wrap:balance}.quote-mark{color:#52e0c4;font-size:86px;line-height:.6}
.caption-cue{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);width:min(1500px,calc(100% - 240px));min-height:104px;padding:18px 42px;border-radius:28px;background:rgba(4,12,22,.94);border:2px solid rgba(82,224,196,.8);color:#fff;font-size:39px;line-height:1.38;font-weight:750;text-align:center;display:grid;place-items:center;white-space:normal;text-wrap:balance;overflow:hidden;z-index:50}
</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-duration="${durationSec.toFixed(3)}" data-width="1920" data-height="1080">
<audio id="narration-audio" class="clip" src="./assets/narration.wav" data-start="0" data-duration="${durationSec.toFixed(3)}" data-track-index="90" data-volume="1"></audio>
${scenes}${captions}</div>
<script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});
${input.plan.scenes.map((_, index) => `tl.fromTo("#scene-content-${index}",{opacity:0,y:24},{opacity:1,y:0,duration:.45,ease:"power2.out"},${starts[index].toFixed(3)});tl.to("#scene-content-${index}",{opacity:0,duration:.35},${Math.max(starts[index], starts[index] + input.sceneDurations[index] - .35).toFixed(3)});tl.set("#scene-content-${index}",{opacity:0},${(starts[index] + input.sceneDurations[index]).toFixed(3)});`).join("")}
tl.to({}, {duration:${durationSec.toFixed(3)}},0);window.__timelines.main=tl;</script></body></html>`;
  await Promise.all([
    writeFile(path.join(input.projectDir, "index.html"), html, "utf8"),
    writeFile(path.join(input.projectDir, "hyperframes.json"), JSON.stringify({ media: { autoProxy: true }, paths: { blocks: "compositions", components: "compositions/components", assets: "assets" } }, null, 2) + "\n", "utf8"),
    writeFile(path.join(input.projectDir, "meta.json"), JSON.stringify({ id: "article-explainer", name: input.plan.title }, null, 2) + "\n", "utf8")
  ]);
  return { sceneStarts: starts, sceneMidpoints: midpoints, durationSec };
}

export function calculateSceneTimeline(sceneDurations: number[]): { sceneStarts: number[]; sceneMidpoints: number[]; durationSec: number } {
  if (sceneDurations.length === 0 || sceneDurations.some((duration) => !Number.isFinite(duration) || duration <= 0)) {
    throw new Error("Scene durations must be finite positive numbers");
  }
  const sceneStarts: number[] = [];
  let cursor = 0;
  for (const duration of sceneDurations) {
    sceneStarts.push(cursor);
    cursor += duration;
  }
  return {
    sceneStarts,
    sceneMidpoints: sceneStarts.map((start, index) => start + sceneDurations[index] / 2),
    durationSec: cursor
  };
}

function renderScene(text: string, supportingText: string, visual: VisualSpec, index: number, start: number, duration: number): string {
  const headlineClass = text.length > 30 ? " tight" : text.length > 22 ? " compact" : "";
  return `<section id="scene-${index}" class="scene clip" data-start="${start.toFixed(3)}" data-duration="${duration.toFixed(3)}" data-track-index="${index + 1}">
<div id="scene-content-${index}" class="scene-content"><div class="copy"><div class="kicker">ARTICLE EXPLAINER</div><div class="headline${headlineClass}">${escapeHtml(text)}</div><div class="supporting">${escapeHtml(supportingText)}</div><div class="counter">${String(index + 1).padStart(2, "0")} / KEY POINT</div></div>
${renderVisual(visual)}</div></section>`;
}

function renderVisual(visual: VisualSpec): string {
  const head = `<div class="visual-head">${visualIcon()}<span>${visualLabel(visual.kind)}</span></div>`;
  if (visual.kind === "title") {
    return `<div class="visual-card">${head}<div class="keyword-list">${visual.keywords.map((item) => `<span class="keyword">${escapeHtml(item)}</span>`).join("")}</div></div>`;
  }
  if (visual.kind === "keypoints" || visual.kind === "steps" || visual.kind === "summary") {
    const marker = visual.kind === "steps" ? "number" : visual.kind === "summary" ? "check" : "dot";
    return `<div class="visual-card">${head}<ul class="visual-list">${visual.items.map((item, index) => `<li><span class="bullet">${marker === "number" ? String(index + 1).padStart(2, "0") : marker === "check" ? "✓" : "●"}</span><span>${escapeHtml(item)}</span></li>`).join("")}</ul></div>`;
  }
  if (visual.kind === "compare") {
    return `<div class="visual-card">${head}<div class="compare-grid">${renderCompareSide(visual.left)}${renderCompareSide(visual.right)}</div></div>`;
  }
  if (visual.kind === "number") {
    return `<div class="visual-card">${head}<div class="number-value">${escapeHtml(visual.value)}</div><div class="number-label">${escapeHtml(visual.label)}</div></div>`;
  }
  return `<div class="visual-card">${head}<div class="quote-mark">“</div><div class="quote-text">${escapeHtml(visual.text)}</div></div>`;
}

function renderCompareSide(side: { label: string; items: string[] }): string {
  return `<div class="compare-side"><div class="compare-label">${escapeHtml(side.label)}</div>${side.items.map((item) => `<div class="compare-item">${escapeHtml(item)}</div>`).join("")}</div>`;
}

function renderCaption(cue: CaptionCue, totalDuration: number): string {
  const start = Math.max(0, Math.min(totalDuration, cue.startMs / 1_000));
  const end = Math.max(start + 0.001, Math.min(totalDuration, cue.endMs / 1_000));
  return `<div id="${escapeHtml(cue.id)}" class="caption-cue clip" data-layout-allow-overlap="true" data-scene="${cue.sceneIndex}" data-start="${start.toFixed(3)}" data-duration="${(end - start).toFixed(3)}" data-track-index="60">${escapeHtml(cue.text)}</div>`;
}

function visualLabel(kind: VisualSpec["kind"]): string {
  return ({ title: "TOPIC", keypoints: "KEY POINTS", steps: "STEPS", compare: "COMPARE", number: "NUMBER", quote: "QUOTE", summary: "SUMMARY" } as const)[kind];
}

function visualIcon(): string {
  return '<svg class="visual-icon" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="18"></circle><path d="M15 25l6 6 13-15"></path></svg>';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
