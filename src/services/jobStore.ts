import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CreateSlideJobInput, SlideJob, SlideJobStatus } from "../types/jobs.js";

const jobsRoot = "jobs";
const statusDirs: SlideJobStatus[] = ["processing", "completed", "failed", "pending"];

export async function createPendingSlideJob(input: CreateSlideJobInput): Promise<SlideJob> {
  const now = new Date();
  const id = `${formatJobTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const pendingDir = path.join(jobsRoot, "pending", id);
  const completedDir = path.join(jobsRoot, "completed", id);

  const job: SlideJob = {
    id,
    url: input.url,
    requestedBy: input.requestedBy,
    sourceChannelId: input.sourceChannelId,
    status: "pending",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    pendingDir,
    completedDir
  };

  await mkdir(pendingDir, { recursive: true });
  await writeJobFile(job, pendingDir);
  return job;
}

export async function readSlideJob(jobId: string): Promise<{ job: SlideJob; dir: string }> {
  for (const status of statusDirs) {
    const dir = path.join(jobsRoot, status, jobId);
    const jobPath = path.join(dir, "job.json");

    if (existsSync(jobPath)) {
      const job = JSON.parse(await readFile(jobPath, "utf8")) as SlideJob;
      return { job, dir };
    }
  }

  throw new Error(`Job not found: ${jobId}`);
}

export async function transitionSlideJob(
  job: SlideJob,
  currentDir: string,
  status: SlideJobStatus,
  patch: Partial<SlideJob> = {}
): Promise<{ job: SlideJob; dir: string }> {
  const nextDir = path.join(jobsRoot, status, job.id);
  const now = new Date().toISOString();
  const nextJob: SlideJob = {
    ...job,
    ...patch,
    status,
    updatedAt: now,
    completedAt: status === "completed" ? patch.completedAt ?? now : patch.completedAt ?? job.completedAt
  };

  if (currentDir !== nextDir) {
    await mkdir(path.dirname(nextDir), { recursive: true });
    if (!existsSync(nextDir)) {
      try {
        await rename(currentDir, nextDir);
      } catch (error) {
        if (isBusyError(error)) {
          await cp(currentDir, nextDir, { recursive: true });
        } else {
          throw error;
        }
      }
    }
  }

  await writeJobFile(nextJob, nextDir);
  return { job: nextJob, dir: nextDir };
}

export async function updateSlideJob(
  job: SlideJob,
  dir: string,
  patch: Partial<SlideJob>
): Promise<SlideJob> {
  const nextJob: SlideJob = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  await writeJobFile(nextJob, dir);
  return nextJob;
}

export function getSlideDataPathForJob(job: SlideJob): string {
  return job.slideDataPath ?? path.join(job.completedDir, "slideData.json");
}

async function writeJobFile(job: SlideJob, dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "job.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

function formatJobTimestamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function isBusyError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EBUSY";
}
