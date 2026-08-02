import { access, mkdir, statfs, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { calculateCaptionTimeline } from "../domains/video/captionTiming.js";
import { doctor, ensureBrowser } from "../domains/video/hyperframesCli.js";
import { probeDuration } from "../domains/video/media.js";
import { getNarrationProvider } from "../domains/video/narrationProvider.js";
import { assertVideoBrowserReady, markVideoBrowserReady, markVideoRuntimeReady } from "../domains/video/preflightState.js";

const ensure = process.argv.includes("--ensure-browser");
const smoke = process.argv.includes("--smoke");
if (ensure) {
  await ensureBrowser();
  await markVideoBrowserReady();
}
await assertVideoBrowserReady();
const report: Record<string, unknown> = { doctor: await doctor() };
await Promise.all([
  access(path.resolve("assets", "video", "NotoSansJP.ttf")),
  access(path.resolve("assets", "video", "OFL.txt"))
]);
await mkdir(path.join("jobs", "video"), { recursive: true });
const probe = path.join("jobs", "video", ".write-probe");
await writeFile(probe, "ok", "utf8");
await unlink(probe);
const disk = await statfs(path.resolve("jobs", "video"));
const freeBytes = disk.bavail * disk.bsize;
report.freeBytes = freeBytes;
if (freeBytes < 3_000_000_000) throw new Error("Video workspace requires at least 3 GB free");

if (smoke) {
  const dir = path.join("jobs", "video", "preflight-smoke");
  await mkdir(dir, { recursive: true });
  const phrases = ["日本語ナレーションを意味単位で生成します。", "字幕は台本と同じ文章を読みやすく表示します。"];
  const provider = getNarrationProvider();
  const timings = [];
  for (let index = 0; index < phrases.length; index += 1) {
    const textPath = path.join(dir, `phrase-${index + 1}.txt`);
    const wavPath = path.join(dir, `phrase-${index + 1}.wav`);
    await writeFile(textPath, phrases[index], "utf8");
    await provider.synthesize({ textFile: textPath, outputPath: wavPath });
    timings.push({ text: phrases[index], durationSec: await probeDuration(wavPath) });
  }
  const timeline = calculateCaptionTimeline([timings]);
  const captionsPath = path.join(dir, "captions.json");
  await writeFile(captionsPath, JSON.stringify(timeline.cues, null, 2) + "\n", "utf8");
  report.smoke = {
    provider: provider.id,
    phraseCount: phrases.length,
    cueCount: timeline.cues.length,
    captionsPath
  };
  await markVideoRuntimeReady();
}
console.log(JSON.stringify(report, null, 2));
