import { config } from "../../config.js";
import { clearArtifactDiagnostic, upsertArtifactDiagnostic, upsertVideoArtifact } from "../../shared/firebaseArticleStore.js";
import { resourceIntensiveSemaphore } from "../../shared/resourceSemaphore.js";
import { notifyVideoCompleted, notifyVideoFailed } from "../../shared/slackNotifier.js";
import { generateVideoLocally, uploadVideoOutputs, VideoActionRequiredError } from "./videoPipeline.js";
import { createVideoJob, listRecoverableVideoJobs, updateVideoJob, type CreateVideoJobInput } from "./videoJobStore.js";
import type { VideoJob } from "./types.js";
import { assertVideoRuntimeReady } from "./preflightState.js";

let queueTail: Promise<void> = Promise.resolve();
const enqueued = new Set<string>();

export async function enqueueVideoGeneration(input: CreateVideoJobInput): Promise<VideoJob> {
  if (!config.video.enabled) throw new Error("VIDEO_GENERATION_DISABLED");
  await assertVideoRuntimeReady();
  const job = await createVideoJob(input);
  await writeVideoState(job, "pending", "video_queued", "動画生成の開始を待っています");
  enqueueExisting(job);
  return job;
}

export async function recoverVideoJobs(): Promise<number> {
  if (!config.video.enabled) return 0;
  await assertVideoRuntimeReady();
  const jobs = await listRecoverableVideoJobs();
  for (const job of jobs) {
    const pending = await updateVideoJob(job, { status: "pending", stage: "video_queued" });
    await writeVideoState(pending, "pending", "video_queued", "中断した動画ジョブの再開を待っています");
    enqueueExisting(pending);
  }
  return jobs.length;
}

function enqueueExisting(job: VideoJob): void {
  if (enqueued.has(job.id)) return;
  enqueued.add(job.id);
  queueTail = queueTail
    .then(() => runQueuedJob(job))
    .catch((error) => console.error(`[video-generate] queue failure: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => enqueued.delete(job.id));
}

async function runQueuedJob(initialJob: VideoJob): Promise<void> {
  let job = initialJob;
  try {
    job = await resourceIntensiveSemaphore.runExclusive(() => generateVideoLocally(
      job,
      (message) => console.log(message),
      async (activeJob, statusMessage) => {
        job = activeJob;
        await writeVideoState(activeJob, "processing", activeJob.stage, statusMessage);
      }
    ));
    await writeVideoState(job, "processing", "video_uploading", "動画をGoogle Driveへ登録しています");
    const uploaded = await uploadVideoOutputs(job);
    job = await updateVideoJob(uploaded.job, { status: "completed", stage: "video_uploading" });
    await upsertVideoArtifact({
      articleUrl: job.url,
      videoUrl: uploaded.url,
      fileId: job.mp4FileId,
      status: "completed",
      stage: "video_uploading",
      statusMessage: "動画を再生できます",
      title: job.sourceTitle,
      durationSec: job.durationSec,
      sizeBytes: job.sizeBytes
    });
    await notifyVideoCompleted({
      channelId: job.sourceChannelId,
      requestedBy: job.sourceChannelId ? job.requestedBy : undefined,
      jobId: job.id,
      videoUrl: uploaded.url
    });
    await upsertArtifactDiagnostic({
      articleUrl: job.url,
      artifactType: "video",
      status: "completed",
      stage: "video_uploading",
      code: "VIDEO_COMPLETED",
      detail: "MP4、project archive、manifestをGoogle Driveへ保存しました",
      jobId: job.id,
      projectArchiveFileId: job.projectArchiveFileId,
      manifestFileId: job.manifestFileId
    });
  } catch (error) {
    const actionRequired = error instanceof VideoActionRequiredError;
    const code = actionRequired ? error.code : "VIDEO_GENERATION_FAILED";
    const detail = error instanceof Error ? error.message : String(error);
    job = await updateVideoJob(job, {
      status: actionRequired ? "action_required" : "failed",
      errorCode: code,
      error: detail.slice(0, 2_000)
    });
    await writeVideoState(
      job,
      actionRequired ? "action_required" : "failed",
      job.stage,
      actionRequired ? "動画生成に手動確認が必要です" : "動画生成に失敗しました",
      { code, detail }
    );
    await notifyVideoFailed({
      channelId: job.sourceChannelId,
      requestedBy: job.sourceChannelId ? job.requestedBy : undefined,
      jobId: job.id,
      code,
      error: detail
    });
  }
}

async function writeVideoState(
  job: VideoJob,
  status: "pending" | "processing" | "action_required" | "failed",
  stage: VideoJob["stage"],
  statusMessage: string,
  diagnostic?: { code: string; detail: string }
): Promise<void> {
  await upsertVideoArtifact({
    articleUrl: job.url,
    videoUrl: "",
    fileId: job.mp4FileId,
    status,
    stage,
    statusMessage,
    title: job.sourceTitle,
    durationSec: job.durationSec,
    sizeBytes: job.sizeBytes
  });
  if (diagnostic) {
    await upsertArtifactDiagnostic({
      articleUrl: job.url,
      artifactType: "video",
      status,
      stage,
      ...diagnostic,
      jobId: job.id
    });
  } else {
    await clearArtifactDiagnostic(job.url, "video");
  }
}
