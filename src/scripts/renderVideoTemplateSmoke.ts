import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { calculateCaptionTimeline, type CaptionPhraseTiming } from "../domains/video/captionTiming.js";
import { createHyperframesProject } from "../domains/video/composition.js";
import { checkProject, lintProject, renderProject, snapshotProject } from "../domains/video/hyperframesCli.js";
import { getNarrationProvider } from "../domains/video/narrationProvider.js";
import { applyAtempo, concatWavFiles, probeDuration, validateFinalVideo } from "../domains/video/media.js";
import { videoPlanSchema } from "../domains/video/types.js";

const root = path.resolve("jobs", "video", "template-smoke");
const audioDir = path.join(root, "audio");
await mkdir(audioDir, { recursive: true });

const plan = videoPlanSchema.parse({
  schemaVersion: 2,
  title: "記事から六十秒解説動画を作る仕組み",
  scenes: [
    {
      narration: "長いウェブ記事の要点を整理します。図解と自然な日本語音声で約六十秒の動画にまとめます。",
      captionPhrases: ["長いウェブ記事の要点を整理します。", "図解と自然な日本語音声で約六十秒の動画にまとめます。"],
      screenText: "記事を六十秒で理解",
      supportingText: "重要な内容だけを選び、短時間で把握できる形へ変換します",
      visual: { kind: "title", keywords: ["記事", "図解", "音声"] },
      evidence: "fixture"
    },
    {
      narration: "本文から重要な根拠を選びます。その根拠に合う画面構成を場面ごとに決めます。",
      captionPhrases: ["本文から重要な根拠を選びます。", "その根拠に合う画面構成を場面ごとに決めます。"],
      screenText: "根拠から構成を設計",
      supportingText: "記事内の事実を基準に、見出しと図解の役割を整理します",
      visual: { kind: "keypoints", items: ["根拠を抽出", "要点を整理", "画面へ反映"] },
      evidence: "fixture"
    },
    {
      narration: "英字語へ適切な読みを付けます。数字や固有名詞も聞き取りやすく整えます。",
      captionPhrases: ["英字語へ適切な読みを付けます。", "数字や固有名詞も聞き取りやすく整えます。"],
      screenText: "読みを段階的に整える",
      supportingText: "原文を保持したまま、音声専用テキストだけを正規化します",
      visual: { kind: "steps", items: ["原文を分割", "読みを正規化", "音声を生成"] },
      evidence: "fixture"
    },
    {
      narration: "汎用音声では発音が不安定でした。日本語解析を加えると自然な読みへ改善しました。",
      captionPhrases: ["汎用音声では発音が不安定でした。", "日本語解析を加えると自然な読みへ改善しました。"],
      screenText: "日本語解析で発音改善",
      supportingText: "日本語向けの解析と辞書を使い、聞きやすい発音を作ります",
      visual: {
        kind: "compare",
        left: { label: "汎用処理", items: ["読みが不安定"] },
        right: { label: "日本語処理", items: ["自然な発音"] }
      },
      evidence: "fixture"
    },
    {
      narration: "各字幕の長さは音声から測ります。実測値で映像と字幕を正確に同期します。",
      captionPhrases: ["各字幕の長さは音声から測ります。", "実測値で映像と字幕を正確に同期します。"],
      screenText: "実測音声で字幕を同期",
      supportingText: "文字数ではなく、生成済み音声の秒数だけから境界を決めます",
      visual: { kind: "number", value: "実測", label: "フレーズごとの音声時間" },
      evidence: "fixture"
    },
    {
      narration: "字幕は一文字ずつ表示しません。意味のまとまりを二行以内で読みやすく示します。",
      captionPhrases: ["字幕は一文字ずつ表示しません。", "意味のまとまりを二行以内で読みやすく示します。"],
      screenText: "意味単位で読める字幕",
      supportingText: "ナレーション台本と完全一致する文章を数秒ずつ表示します",
      visual: { kind: "quote", text: "意味のまとまりを二行以内で表示" },
      evidence: "fixture"
    },
    {
      narration: "完成動画はドライブへ保存できます。記事ビューアーから再生し、外部リンクでも開けます。",
      captionPhrases: ["完成動画はドライブへ保存できます。", "記事ビューアーから再生し、外部リンクでも開けます。"],
      screenText: "Drive経由でViewer再生",
      supportingText: "既存の保存方式と再生契約を変えずに、映像品質だけを改善します",
      visual: { kind: "summary", items: ["ローカル生成", "Drive保存", "Viewer再生"] },
      evidence: "fixture"
    }
  ]
});

const provider = getNarrationProvider();
const rawGroups: Array<Array<CaptionPhraseTiming & { path: string }>> = [];
for (let sceneIndex = 0; sceneIndex < plan.scenes.length; sceneIndex += 1) {
  const group: Array<CaptionPhraseTiming & { path: string }> = [];
  for (let phraseIndex = 0; phraseIndex < plan.scenes[sceneIndex].captionPhrases.length; phraseIndex += 1) {
    const stem = `scene-${String(sceneIndex + 1).padStart(2, "0")}-cue-${String(phraseIndex + 1).padStart(2, "0")}`;
    const textPath = path.join(audioDir, `${stem}.txt`);
    const audioPath = path.join(audioDir, `${stem}.wav`);
    const text = plan.scenes[sceneIndex].captionPhrases[phraseIndex];
    await writeFile(textPath, text, "utf8");
    await provider.synthesize({ textFile: textPath, outputPath: audioPath });
    group.push({ text, path: audioPath, durationSec: await probeDuration(audioPath) });
  }
  rawGroups.push(group);
}

const sourceTotal = rawGroups.flat().reduce((total, phrase) => total + phrase.durationSec, 0);
const tempoFactor = sourceTotal >= 55 && sourceTotal <= 65 ? 1 : sourceTotal / 60;
if (tempoFactor < 0.9 || tempoFactor > 1.1) {
  throw new Error(`Template narration duration ${sourceTotal.toFixed(3)}s cannot be corrected safely`);
}

const adjustedGroups: Array<Array<CaptionPhraseTiming & { path: string }>> = [];
const sceneAudioPaths: string[] = [];
for (let sceneIndex = 0; sceneIndex < rawGroups.length; sceneIndex += 1) {
  const group: Array<CaptionPhraseTiming & { path: string }> = [];
  for (let phraseIndex = 0; phraseIndex < rawGroups[sceneIndex].length; phraseIndex += 1) {
    const outputPath = path.join(audioDir, `scene-${String(sceneIndex + 1).padStart(2, "0")}-cue-${String(phraseIndex + 1).padStart(2, "0")}.tempo.wav`);
    if (tempoFactor === 1) await copyFile(rawGroups[sceneIndex][phraseIndex].path, outputPath);
    else await applyAtempo(rawGroups[sceneIndex][phraseIndex].path, outputPath, tempoFactor);
    group.push({
      text: rawGroups[sceneIndex][phraseIndex].text,
      path: outputPath,
      durationSec: await probeDuration(outputPath)
    });
  }
  adjustedGroups.push(group);
  const scenePath = path.join(audioDir, `scene-${String(sceneIndex + 1).padStart(2, "0")}.tempo.wav`);
  await concatWavFiles(group.map((phrase) => phrase.path), scenePath);
  sceneAudioPaths.push(scenePath);
}

const timeline = calculateCaptionTimeline(adjustedGroups);
const narrationPath = path.join(root, "narration.wav");
await concatWavFiles(sceneAudioPaths, narrationPath);
const narrationDuration = await probeDuration(narrationPath);
if (narrationDuration < 55 || narrationDuration > 65) {
  throw new Error(`Final template narration is ${narrationDuration.toFixed(3)}s`);
}
await writeFile(path.join(root, "captions.json"), JSON.stringify(timeline.cues, null, 2) + "\n", "utf8");

const projectDir = path.join(root, "project");
const composition = await createHyperframesProject({
  projectDir,
  plan,
  sceneDurations: await Promise.all(sceneAudioPaths.map((scenePath) => probeDuration(scenePath))),
  captions: timeline.cues,
  narrationPath
});
await lintProject(projectDir);
await checkProject(projectDir, composition.sceneMidpoints);
await snapshotProject(projectDir, path.join(root, "snapshots"), composition.sceneMidpoints);

const outputPath = path.join(root, "output.mp4");
await renderProject(projectDir, outputPath);
const validated = await validateFinalVideo(outputPath);
const output = await stat(outputPath);
const result = {
  schemaVersion: 2,
  provider: provider.id,
  sourceTotal,
  tempoFactor,
  phraseDurations: timeline.phraseDurations,
  cueCount: timeline.cues.length,
  sceneDurations: composition.sceneStarts.map((start, index) =>
    index === composition.sceneStarts.length - 1 ? composition.durationSec - start : composition.sceneStarts[index + 1] - start
  ),
  narrationDuration,
  outputPath,
  sizeBytes: output.size,
  ...validated
};
await writeFile(path.join(root, "smoke-result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify(result, null, 2));
