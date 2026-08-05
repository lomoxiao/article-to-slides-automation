import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { newJobId, writeJobJson } from "../../shared/jobFiles.js";
import { isSafeJobId } from "../../utils/safeJobId.js";
import type { VideoJob } from "./types.js";

const jobsRoot = path.join("jobs", "video");
const schema = z.object({
  id: z.string(), url: z.string().min(1), inputHash: z.string(), status: z.string(), stage: z.string(),
  createdAt: z.string(), updatedAt: z.string(), jobDir: z.string()
}).passthrough();

export type CreateVideoJobInput = Pick<VideoJob, "url" | "sourceText" | "sourceTitle" | "audience" | "focus" | "motionMode" | "requestedBy" | "sourceChannelId" | "executionMode">;

export async function createVideoJob(input: CreateVideoJobInput): Promise<VideoJob> {
  const now = new Date();
  const id = newJobId(now);
  const jobDir = path.join(jobsRoot, id);
  const job: VideoJob = {
    ...input,
    motionMode: input.motionMode ?? "rich",
    id,
    inputHash: hashVideoInput({ ...input, motionMode: input.motionMode ?? "rich" }),
    status: "pending",
    stage: "video_queued",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    jobDir,
    completedSteps: []
  };
  await Promise.all(["audio", "project", "snapshots", "logs", "checkpoints"].map((name) => mkdir(path.join(jobDir, name), { recursive: true })));
  await writeJobJson(jobDir, job);
  return job;
}

export async function readVideoJob(jobId: string): Promise<VideoJob | undefined> {
  if (!isSafeJobId(jobId)) return undefined;
  try {
    const raw = await readFile(path.join(jobsRoot, jobId, "job.json"), "utf8");
    return schema.parse(JSON.parse(raw)) as VideoJob;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function updateVideoJob(job: VideoJob, patch: Partial<VideoJob>): Promise<VideoJob> {
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  await writeJobJson(next.jobDir, next);
  return next;
}

export async function listVideoJobs(): Promise<VideoJob[]> {
  let entries: string[];
  try { entries = await readdir(jobsRoot); } catch { return []; }
  const jobs = await Promise.all(entries.map((id) => readVideoJob(id).catch(() => undefined)));
  return jobs.filter((job): job is VideoJob => Boolean(job));
}

export async function listInterruptedVideoJobs(): Promise<VideoJob[]> {
  const jobs = await listVideoJobs();
  return jobs.filter((job) => job.status === "pending" || job.status === "processing");
}

export function isManagedVideoJob(job: VideoJob): boolean {
  return job.executionMode === "managed" || (job.executionMode === undefined && job.requestedBy !== "cli");
}

function hashVideoInput(input: CreateVideoJobInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
