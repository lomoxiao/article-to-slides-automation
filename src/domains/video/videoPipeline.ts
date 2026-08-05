import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import { config } from "../../config.js";
import { upsertDriveBinary } from "../../shared/driveBinaryUploader.js";
import { fetchSourceContent } from "../../shared/sourceAggregator.js";
import { calculateCaptionTimeline, findShortCaptionMerge, type CaptionPhraseTiming } from "./captionTiming.js";
import { createHyperframesProject } from "./composition.js";
import { checkProject, HyperframesProjectValidationError, lintProject, renderProject, snapshotProject } from "./hyperframesCli.js";
import { getNarrationProvider } from "./narrationProvider.js";
import { generateMotionPlan } from "./motionPlan.js";
import { createBasicMotionPlan, motionPlanSchema, validateMotionPlanContract, type MotionPlan } from "./motionTypes.js";
import { assertVideoBrowserReady } from "./preflightState.js";
import { applyAtempo, concatWavFiles, probeDuration, validateFinalVideo } from "./media.js";
import { generateVideoPlan, targetNarrationCharacters } from "./videoPlan.js";
import { updateVideoJob } from "./videoJobStore.js";
import {
  captionCueSchema,
  videoPlanSchema,
  type CaptionCue,
  type VideoArtifactKind,
  type VideoJob,
  type VideoPlan
} from "./types.js";

const CHECKPOINT_VERSIONS: Record<string, number> = {
  source: 1,
  plan: 2,
  storyboard: 1,
  tts: 2,
  captions: 2,
  render: 3
};

export function checkpointVersionForStep(step: string): number {
  return CHECKPOINT_VERSIONS[step] ?? 1;
}

export function isCheckpointVersionCompatible(step: string, actualVersion: number | undefined): boolean {
  return (actualVersion ?? 1) === checkpointVersionForStep(step);
}

type PhraseAudio = CaptionPhraseTiming & { rawPath: string };
type CaptionAudioState = {
  captions: CaptionCue[];
  sceneDurations: number[];
  phraseDurations: number[][];
  scenePaths: string[];
  cuePaths: string[];
  narrationDuration: number;
};

export class VideoActionRequiredError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "VideoActionRequiredError";
  }
}

export type VideoProgressReporter = (job: VideoJob, statusMessage: string) => Promise<void>;

export async function generateVideoLocally(
  initialJob: VideoJob,
  logger: (message: string) => void = console.log,
  onProgress?: VideoProgressReporter
): Promise<VideoJob> {
  let job = initialJob;
  const outputPath = path.join(job.jobDir, "output.mp4");
  const manifestPath = path.join(job.jobDir, "manifest.json");
  const archivePath = path.join(job.jobDir, "project.zip");
  if (await hasValidCheckpoint(job, "render", [outputPath, manifestPath, archivePath])) {
    try {
      const validated = await validateFinalVideo(outputPath);
      return updateVideoJob(job, { durationSec: validated.durationSec });
    } catch {
      // The checkpoint or artifact is stale; resume from the preceding valid stage.
    }
  }

  await assertVideoBrowserReady();
  job = await updateVideoJob(job, { status: "processing", stage: "video_planning", error: undefined, errorCode: undefined });
  await onProgress?.(job, "動画の構成を生成しています");
  const sourcePath = path.join(job.jobDir, "source.txt");
  let source: { url: string; title: string; text: string };
  if (await hasValidCheckpoint(job, "source", [sourcePath])) {
    source = { url: job.url, title: job.sourceTitle ?? job.url, text: await readFile(sourcePath, "utf8") };
  } else {
    source = job.sourceText
      ? { url: job.url, title: job.sourceTitle ?? job.url, text: job.sourceText }
      : await fetchSourceContent(job.url);
    await writeFile(sourcePath, source.text, "utf8");
    await writeCheckpoint(job, "source", [sourcePath]);
  }

  const planPath = path.join(job.jobDir, "videoPlan.json");
  let plan: VideoPlan;
  if (await hasValidCheckpoint(job, "plan", [planPath])) {
    plan = videoPlanSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
    assertEvidenceMatchesSource(plan, source.text);
  } else {
    logger(`[video] ${job.id}: planning v2`);
    plan = await generateVideoPlan({
      source: source.text, title: source.title, audience: job.audience, focus: job.focus, jobDir: job.jobDir
    });
    await savePlan(job, plan);
    await writeCheckpoint(job, "plan", [planPath]);
  }

  const motionPlanPath = path.join(job.jobDir, "motionPlan.json");
  const requestedMotionMode = job.motionMode ?? "basic";
  let motionPlan: MotionPlan;
  let motionFallbackReason = job.motionFallbackReason;
  if (requestedMotionMode !== "rich" || !config.video.richMotionEnabled) {
    motionPlan = createBasicMotionPlan(plan);
    motionFallbackReason = requestedMotionMode === "rich" ? "VIDEO_RICH_MOTION_ENABLED is false" : undefined;
    await writeFile(motionPlanPath, JSON.stringify(motionPlan, null, 2) + "\n", "utf8");
    await writeCheckpoint(job, "storyboard", [motionPlanPath]);
  } else if (await hasValidCheckpoint(job, "storyboard", [motionPlanPath])) {
    motionPlan = motionPlanSchema.parse(JSON.parse(await readFile(motionPlanPath, "utf8")));
    validateMotionPlanContract(motionPlan, plan);
  } else {
    logger(`[video] ${job.id}: rich motion storyboarding v1`);
    const generated = await generateMotionPlan({ plan, audience: job.audience, focus: job.focus, jobDir: job.jobDir });
    motionPlan = generated.plan;
    motionFallbackReason = generated.fallbackReason;
    await writeFile(motionPlanPath, JSON.stringify(motionPlan, null, 2) + "\n", "utf8");
    await writeCheckpoint(job, "storyboard", [motionPlanPath]);
  }
  const motionModeUsed = motionPlan.scenes.some((scene) => scene.diagram.kind !== "legacy") ? "rich" : "basic";
  job = await updateVideoJob(job, { motionModeUsed, motionFallbackReason });

  job = await updateVideoJob(job, { stage: "video_tts", completedSteps: ["source", "plan", "storyboard"] });
  await onProgress?.(job, "意味単位で日本語ナレーションを生成しています");
  const captionsPath = path.join(job.jobDir, "captions.json");
  const narrationPath = path.join(job.jobDir, "audio", "narration.wav");
  const checkpointState = await loadCaptionCheckpoint(job, plan, captionsPath, narrationPath);
  let audioState: CaptionAudioState;

  if (checkpointState) {
    audioState = checkpointState;
  } else {
    let groups = await synthesizeCaptionGroups(job, plan);
    groups = await mergeShortPhrases(job, groups, 1);
    let total = sumPhraseDurations(groups);

    if (shouldRecoverNarration(total, job.durationRecoveryAttempted)) {
      job = await updateVideoJob(job, { durationRecoveryAttempted: true });
      const targetCharacters = targetNarrationCharacters(plan, total);
      logger(`[video] ${job.id}: duration recovery ${total.toFixed(2)}s -> target ${targetCharacters} chars`);
      plan = await generateVideoPlan({
        source: source.text, title: source.title, audience: job.audience, focus: job.focus, jobDir: job.jobDir,
        targetCharacters, previousPlan: plan
      });
      await savePlan(job, plan);
      await writeCheckpoint(job, "plan", [planPath]);
      groups = await synthesizeCaptionGroups(job, plan);
      groups = await mergeShortPhrases(job, groups, 1);
      total = sumPhraseDurations(groups);
    }

    let tempoFactor = calculateTempoFactor(total);
    for (let pass = 0; pass < 8; pass += 1) {
      const merged = await mergeFirstShortPhrase(job, groups, tempoFactor, pass);
      if (!merged) break;
      groups = merged;
      total = sumPhraseDurations(groups);
      tempoFactor = calculateTempoFactor(total);
    }

    job = await updateVideoJob(job, {
      stage: "video_captioning",
      completedSteps: ["source", "plan", "storyboard", "tts"]
    });
    await onProgress?.(job, "意味単位の字幕タイミングを確定しています");
    audioState = await finalizeCaptionAudio(job, groups, tempoFactor, captionsPath, narrationPath);
    if (audioState.narrationDuration < 55 || audioState.narrationDuration > 65) {
      throw new VideoActionRequiredError("DURATION_OUT_OF_RANGE", `Final narration is ${audioState.narrationDuration.toFixed(2)}s`);
    }
    const checkpointArtifacts = [
      narrationPath,
      captionsPath,
      ...audioState.scenePaths,
      ...audioState.cuePaths
    ];
    await writeCheckpoint(job, "tts", checkpointArtifacts);
    await writeCheckpoint(job, "captions", [captionsPath, ...audioState.cuePaths]);
  }

  job = await updateVideoJob(job, {
    stage: "video_rendering",
    completedSteps: ["source", "plan", "storyboard", "tts", "captions"]
  });
  await onProgress?.(job, "MP4をレンダリングしています");
  const projectDir = path.join(job.jobDir, "project");
  let composition = await createHyperframesProject({
    projectDir, plan, motionPlan, sceneDurations: audioState.sceneDurations,
    captions: audioState.captions, narrationPath
  });
  logger(`[video] ${job.id}: lint/check/snapshot/render (${job.motionModeUsed})`);
  try {
    await lintProject(projectDir);
    await checkProject(projectDir, composition.inspectionTimes);
  } catch (error) {
    if (job.motionModeUsed !== "rich" || !(error instanceof HyperframesProjectValidationError)) throw error;
    motionFallbackReason = `Rich composition preflight failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000);
    motionPlan = createBasicMotionPlan(plan);
    await writeFile(motionPlanPath, JSON.stringify(motionPlan, null, 2) + "\n", "utf8");
    await writeCheckpoint(job, "storyboard", [motionPlanPath]);
    job = await updateVideoJob(job, { motionModeUsed: "basic", motionFallbackReason });
    composition = await createHyperframesProject({
      projectDir, plan, motionPlan, sceneDurations: audioState.sceneDurations,
      captions: audioState.captions, narrationPath
    });
    await lintProject(projectDir);
    await checkProject(projectDir, composition.inspectionTimes);
  }
  await snapshotProject(projectDir, path.join(job.jobDir, "snapshots"), composition.sceneSnapshotTimes);
  await renderProject(projectDir, outputPath);
  const validated = await validateFinalVideo(outputPath);
  const file = await stat(outputPath);
  if (file.size <= 0 || file.size > config.video.maxFileBytes) {
    throw new VideoActionRequiredError("VIDEO_FILE_SIZE_INVALID", `MP4 size ${file.size} is outside the allowed range`);
  }

  job = await updateVideoJob(job, {
    completedSteps: ["source", "plan", "storyboard", "tts", "captions", "render"],
    durationSec: validated.durationSec,
    sizeBytes: file.size
  });
  await writeManifest(job, plan, motionPlan, audioState.sceneDurations, audioState.captions, audioState.phraseDurations);
  await createProjectArchive(job);
  await writeCheckpoint(job, "render", [outputPath, manifestPath, archivePath]);
  return job;
}

export async function uploadVideoOutputs(initialJob: VideoJob): Promise<{ job: VideoJob; url: string }> {
  if (!config.video.driveFolderId) throw new VideoActionRequiredError("DRIVE_CONFIGURATION_MISSING", "VIDEO_DRIVE_FOLDER_ID is not configured");
  let job = await updateVideoJob(initialJob, { stage: "video_uploading", driveFolderId: config.video.driveFolderId });
  const mp4 = await uploadArtifact(job, "mp4", path.join(job.jobDir, "output.mp4"), "video/mp4", `${job.id}.mp4`);
  job = mp4.job;
  const archive = await uploadArtifact(job, "projectArchive", path.join(job.jobDir, "project.zip"), "application/zip", `${job.id}-project.zip`);
  job = archive.job;
  const plan = videoPlanSchema.parse(JSON.parse(await readFile(path.join(job.jobDir, "videoPlan.json"), "utf8")));
  const motionPlan = motionPlanSchema.parse(JSON.parse(await readFile(path.join(job.jobDir, "motionPlan.json"), "utf8")));
  const captions = parseCaptionCues(JSON.parse(await readFile(path.join(job.jobDir, "captions.json"), "utf8")), plan.scenes.length);
  const localManifest = JSON.parse(await readFile(path.join(job.jobDir, "manifest.json"), "utf8")) as {
    sceneDurations?: number[]; captions?: { phraseDurations?: number[][] };
  };
  await writeManifest(job, plan, motionPlan, localManifest.sceneDurations ?? [], captions, localManifest.captions?.phraseDurations ?? []);
  const manifest = await uploadArtifact(job, "manifest", path.join(job.jobDir, "manifest.json"), "application/json", `${job.id}-manifest.json`);
  job = manifest.job;
  await writeManifest(job, plan, motionPlan, localManifest.sceneDurations ?? [], captions, localManifest.captions?.phraseDurations ?? []);
  job = (await uploadArtifact(job, "manifest", path.join(job.jobDir, "manifest.json"), "application/json", `${job.id}-manifest.json`)).job;
  const fileId = job.mp4FileId;
  if (!fileId) throw new VideoActionRequiredError("DRIVE_CREATE_INDETERMINATE", "MP4 file ID was not persisted");
  return { job, url: mp4.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view` };
}

async function synthesizeCaptionGroups(job: VideoJob, plan: VideoPlan): Promise<PhraseAudio[][]> {
  const groups: PhraseAudio[][] = [];
  for (let sceneIndex = 0; sceneIndex < plan.scenes.length; sceneIndex += 1) {
    const phrases: PhraseAudio[] = [];
    for (let phraseIndex = 0; phraseIndex < plan.scenes[sceneIndex].captionPhrases.length; phraseIndex += 1) {
      phrases.push(await synthesizePhrase(job, sceneIndex, phraseIndex, plan.scenes[sceneIndex].captionPhrases[phraseIndex], "raw"));
    }
    groups.push(phrases);
  }
  return groups;
}

async function synthesizePhrase(
  job: VideoJob,
  sceneIndex: number,
  phraseIndex: number,
  text: string,
  suffix: string
): Promise<PhraseAudio> {
  const stem = `scene-${String(sceneIndex + 1).padStart(2, "0")}-cue-${String(phraseIndex + 1).padStart(2, "0")}.${suffix}`;
  const textPath = path.join(job.jobDir, "audio", `${stem}.txt`);
  const rawPath = path.join(job.jobDir, "audio", `${stem}.wav`);
  await writeFile(textPath, text, "utf8");
  await getNarrationProvider().synthesize({ textFile: textPath, outputPath: rawPath });
  return { text, rawPath, durationSec: await probeDuration(rawPath) };
}

async function mergeShortPhrases(job: VideoJob, groups: PhraseAudio[][], tempoFactor: number): Promise<PhraseAudio[][]> {
  let current = groups;
  for (let pass = 0; pass < 8; pass += 1) {
    const merged = await mergeFirstShortPhrase(job, current, tempoFactor, pass);
    if (!merged) return current;
    current = merged;
  }
  return current;
}

async function mergeFirstShortPhrase(
  job: VideoJob,
  groups: PhraseAudio[][],
  tempoFactor: number,
  pass: number
): Promise<PhraseAudio[][] | undefined> {
  for (let sceneIndex = 0; sceneIndex < groups.length; sceneIndex += 1) {
    const pair = findShortCaptionMerge(groups[sceneIndex], tempoFactor);
    if (!pair) continue;
    const [from, to] = pair;
    const mergedText = groups[sceneIndex].slice(from, to + 1).map((phrase) => phrase.text).join("");
    const merged = await synthesizePhrase(job, sceneIndex, from, mergedText, `merge-${pass + 1}`);
    const next = groups.map((group) => [...group]);
    next[sceneIndex].splice(from, to - from + 1, merged);
    return next;
  }
  return undefined;
}

async function finalizeCaptionAudio(
  job: VideoJob,
  groups: PhraseAudio[][],
  tempoFactor: number,
  captionsPath: string,
  narrationPath: string
): Promise<CaptionAudioState> {
  const adjustedGroups: Array<Array<PhraseAudio & { tempoPath: string }>> = [];
  const cuePaths: string[] = [];
  for (let sceneIndex = 0; sceneIndex < groups.length; sceneIndex += 1) {
    const adjusted: Array<PhraseAudio & { tempoPath: string }> = [];
    for (let phraseIndex = 0; phraseIndex < groups[sceneIndex].length; phraseIndex += 1) {
      const tempoPath = captionTempoPath(job, sceneIndex, phraseIndex);
      if (tempoFactor === 1) await copyFile(groups[sceneIndex][phraseIndex].rawPath, tempoPath);
      else await applyAtempo(groups[sceneIndex][phraseIndex].rawPath, tempoPath, tempoFactor);
      const durationSec = await probeDuration(tempoPath);
      if (durationSec < 1.495 || durationSec > 6) {
        throw new VideoActionRequiredError(
          "CAPTION_DURATION_INVALID",
          `Scene ${sceneIndex + 1} caption ${phraseIndex + 1} is ${durationSec.toFixed(2)}s`
        );
      }
      adjusted.push({ ...groups[sceneIndex][phraseIndex], durationSec, tempoPath });
      cuePaths.push(tempoPath);
    }
    adjustedGroups.push(adjusted);
  }

  let timeline;
  try {
    timeline = calculateCaptionTimeline(adjustedGroups);
  } catch (error) {
    throw new VideoActionRequiredError("CAPTION_DURATION_INVALID", error instanceof Error ? error.message : String(error));
  }
  await writeFile(captionsPath, JSON.stringify(timeline.cues, null, 2) + "\n", "utf8");

  const scenePaths: string[] = [];
  for (let sceneIndex = 0; sceneIndex < adjustedGroups.length; sceneIndex += 1) {
    const scenePath = sceneTempoPath(job, sceneIndex);
    await concatWavFiles(adjustedGroups[sceneIndex].map((phrase) => phrase.tempoPath), scenePath);
    scenePaths.push(scenePath);
  }
  await concatWavFiles(scenePaths, narrationPath);
  return {
    captions: timeline.cues,
    sceneDurations: await Promise.all(scenePaths.map((scenePath) => probeDuration(scenePath))),
    phraseDurations: timeline.phraseDurations,
    scenePaths,
    cuePaths,
    narrationDuration: await probeDuration(narrationPath)
  };
}

async function loadCaptionCheckpoint(
  job: VideoJob,
  plan: VideoPlan,
  captionsPath: string,
  narrationPath: string
): Promise<CaptionAudioState | undefined> {
  try {
    const captions = parseCaptionCues(JSON.parse(await readFile(captionsPath, "utf8")), plan.scenes.length);
    const cuePaths = captionPathsFromCues(job, captions);
    const scenePaths = plan.scenes.map((_, index) => sceneTempoPath(job, index));
    const allArtifacts = [narrationPath, captionsPath, ...scenePaths, ...cuePaths];
    if (
      !(await hasValidCheckpoint(job, "tts", allArtifacts))
      || !(await hasValidCheckpoint(job, "captions", [captionsPath, ...cuePaths]))
    ) return undefined;
    const phraseDurations = plan.scenes.map((_, sceneIndex) =>
      captions.filter((cue) => cue.sceneIndex === sceneIndex).map((cue) => (cue.endMs - cue.startMs) / 1_000)
    );
    return {
      captions,
      sceneDurations: await Promise.all(scenePaths.map((scenePath) => probeDuration(scenePath))),
      phraseDurations,
      scenePaths,
      cuePaths,
      narrationDuration: await probeDuration(narrationPath)
    };
  } catch {
    return undefined;
  }
}

function parseCaptionCues(raw: unknown, sceneCount: number): CaptionCue[] {
  const cues = captionCueSchema.array().min(1).parse(raw);
  let previousEnd = 0;
  const ids = new Set<string>();
  for (const cue of cues) {
    if (cue.sceneIndex >= sceneCount || cue.startMs !== previousEnd || ids.has(cue.id)) {
      throw new Error("Invalid caption cue sequence");
    }
    ids.add(cue.id);
    previousEnd = cue.endMs;
  }
  return cues;
}

function captionPathsFromCues(job: VideoJob, captions: CaptionCue[]): string[] {
  const counts = new Map<number, number>();
  return captions.map((cue) => {
    const index = counts.get(cue.sceneIndex) ?? 0;
    counts.set(cue.sceneIndex, index + 1);
    return captionTempoPath(job, cue.sceneIndex, index);
  });
}

function captionTempoPath(job: VideoJob, sceneIndex: number, phraseIndex: number): string {
  return path.join(
    job.jobDir,
    "audio",
    `scene-${String(sceneIndex + 1).padStart(2, "0")}-cue-${String(phraseIndex + 1).padStart(2, "0")}.tempo.wav`
  );
}

function sceneTempoPath(job: VideoJob, sceneIndex: number): string {
  return path.join(job.jobDir, "audio", `scene-${String(sceneIndex + 1).padStart(2, "0")}.tempo.wav`);
}

export function calculateTempoFactor(total: number): number {
  const factor = total >= 55 && total <= 65 ? 1 : Math.max(0.9, Math.min(1.1, total / 60));
  const projectedDuration = total / factor;
  if (projectedDuration < 55 || projectedDuration > 65) {
    throw new VideoActionRequiredError("DURATION_OUT_OF_RANGE", `Narration duration ${total.toFixed(2)}s cannot be corrected safely`);
  }
  return factor;
}

export function shouldRecoverNarration(total: number, attempted = false): boolean {
  return !attempted && (total < 55 || total > 65);
}

async function savePlan(job: VideoJob, plan: VideoPlan): Promise<void> {
  await writeFile(path.join(job.jobDir, "videoPlan.json"), JSON.stringify(plan, null, 2) + "\n", "utf8");
}

async function writeManifest(
  job: VideoJob,
  plan: VideoPlan,
  motionPlan: MotionPlan,
  sceneDurations: number[],
  captions: CaptionCue[],
  phraseDurations: number[][]
): Promise<void> {
  const manifest = {
    schemaVersion: 2,
    pipelineVersion: 3,
    jobId: job.id,
    sourceUrl: job.url,
    inputHash: job.inputHash,
    hyperframesVersion: "0.7.87",
    tts: { provider: getNarrationProvider().id, voice: config.video.ttsVoice, speed: config.video.ttsSpeed, language: "ja" },
    captions: {
      source: "tts-phrases",
      cuesFile: "captions.json",
      cueCount: captions.length,
      phraseDurations
    },
    sceneDurations,
    motion: {
      requested: job.motionMode ?? "basic",
      used: job.motionModeUsed ?? "basic",
      theme: motionPlan.theme,
      storyboardFile: "motionPlan.json",
      templates: motionPlan.scenes.map((scene) => scene.diagram.kind),
      fallbackReason: job.motionFallbackReason
    },
    durationSec: job.durationSec,
    sizeBytes: job.sizeBytes,
    drive: {
      folderId: job.driveFolderId,
      mp4FileId: job.mp4FileId,
      projectArchiveFileId: job.projectArchiveFileId,
      manifestFileId: job.manifestFileId
    },
    plan
  };
  await writeFile(path.join(job.jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

async function createProjectArchive(job: VideoJob): Promise<void> {
  const outputPath = path.join(job.jobDir, "project.zip");
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const zip = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    zip.on("error", reject);
    zip.pipe(output);
    zip.directory(path.join(job.jobDir, "project"), "project");
    for (const name of ["source.txt", "videoPlan.json", "motionPlan.json", "captions.json", "manifest.json"]) {
      zip.file(path.join(job.jobDir, name), { name });
    }
    void zip.finalize();
  });
}

async function uploadArtifact(
  initialJob: VideoJob,
  kind: VideoArtifactKind,
  filePath: string,
  mimeType: string,
  name: string
): Promise<{ job: VideoJob; webViewLink?: string }> {
  const idField = kind === "mp4" ? "mp4FileId" : kind === "projectArchive" ? "projectArchiveFileId" : "manifestFileId";
  const existingId = initialJob[idField];
  if (!existingId && initialJob.createPending?.[kind]) {
    throw new VideoActionRequiredError("DRIVE_CREATE_INDETERMINATE", `${kind} create was interrupted before fileId persistence`);
  }
  let job = initialJob;
  if (!existingId) job = await updateVideoJob(job, { createPending: { ...job.createPending, [kind]: true } });
  try {
    const result = await upsertDriveBinary({
      fileId: existingId,
      parentFolderId: config.video.driveFolderId!,
      name,
      mimeType,
      filePath,
      appProperties: { videoJobId: job.id, artifactKind: kind }
    });
    job = await updateVideoJob(job, {
      [idField]: result.fileId,
      createPending: { ...job.createPending, [kind]: false }
    });
    return { job, webViewLink: result.webViewLink };
  } catch (error) {
    if (existingId) throw new VideoActionRequiredError("DRIVE_FILE_NOT_FOUND", error instanceof Error ? error.message : String(error));
    throw new VideoActionRequiredError("DRIVE_CREATE_INDETERMINATE", error instanceof Error ? error.message : String(error));
  }
}

async function writeCheckpoint(job: VideoJob, step: string, artifactPaths: string[]): Promise<void> {
  const relativeArtifacts = artifactPaths.map((artifactPath) => checkpointRelativePath(job, artifactPath));
  await validateCheckpointArtifacts(artifactPaths);
  const dir = path.join(job.jobDir, "checkpoints");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${step}.json`), JSON.stringify({
    inputHash: job.inputHash,
    step,
    stepVersion: checkpointVersionForStep(step),
    artifacts: relativeArtifacts,
    completedAt: new Date().toISOString()
  }, null, 2) + "\n", "utf8");
}

async function hasValidCheckpoint(job: VideoJob, step: string, artifactPaths: string[]): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(path.join(job.jobDir, "checkpoints", `${step}.json`), "utf8")) as {
      inputHash?: string; step?: string; stepVersion?: number; artifacts?: unknown;
    };
    const expected = artifactPaths.map((artifactPath) => checkpointRelativePath(job, artifactPath));
    const versionCompatible = isCheckpointVersionCompatible(step, marker.stepVersion);
    if (
      marker.inputHash !== job.inputHash
      || marker.step !== step
      || !versionCompatible
      || !Array.isArray(marker.artifacts)
      || JSON.stringify(marker.artifacts) !== JSON.stringify(expected)
    ) return false;
    await validateCheckpointArtifacts(artifactPaths);
    return true;
  } catch {
    return false;
  }
}

async function validateCheckpointArtifacts(artifactPaths: string[]): Promise<void> {
  for (const artifactPath of artifactPaths) {
    const artifact = await stat(artifactPath);
    if (!artifact.isFile() || artifact.size <= 0) throw new Error(`Invalid checkpoint artifact: ${artifactPath}`);
  }
}

function checkpointRelativePath(job: VideoJob, artifactPath: string): string {
  const relative = path.relative(job.jobDir, artifactPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Checkpoint artifact is outside the video job: ${artifactPath}`);
  }
  return relative.replaceAll("\\", "/");
}

function assertEvidenceMatchesSource(plan: VideoPlan, source: string): void {
  plan.scenes.forEach((scene, index) => {
    if (!source.includes(scene.evidence)) throw new Error(`Scene ${index + 1} evidence is not present in source`);
  });
}

function sumPhraseDurations(groups: PhraseAudio[][]): number {
  return groups.flat().reduce((total, phrase) => total + phrase.durationSec, 0);
}
