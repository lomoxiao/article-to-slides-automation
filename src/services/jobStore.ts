import { cp, mkdir, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CreateSlideJobInput, SlideJob, SlideJobStatus } from "../types/jobs.js";
import { assertSafeJobId } from "../utils/safeJobId.js";
import { newJobId, writeJobJson } from "./jobFiles.js";

const jobsRoot = "jobs";
const statusDirs: SlideJobStatus[] = ["processing", "completed", "failed", "pending"];

// job.json は外部から書き換え可能なファイルのため、読み込み時に必ず検証する。
// 将来フィールドが増えても古いコードで読めるよう、未知キーは passthrough で保持する。
const slideJobSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  pendingDir: z.string(),
  completedDir: z.string(),
  url: z.string().optional(),
  urls: z.array(z.string()).optional(),
  researchPrompt: z.string().optional(),
  sourceText: z.string().optional(),
  sourceTitle: z.string().optional(),
  audience: z.string().optional(),
  focus: z.string().optional(),
  pages: z.number().optional(),
  requestedBy: z.string().optional(),
  sourceChannelId: z.string().optional(),
  completedAt: z.string().optional(),
  slideDataPath: z.string().optional(),
  deckUrl: z.string().optional(),
  presentationId: z.string().optional(),
  error: z.string().optional()
}).passthrough();

function parseSlideJobFile(raw: string, jobPath: string): SlideJob {
  try {
    return slideJobSchema.parse(JSON.parse(raw)) as SlideJob;
  } catch (error) {
    throw new Error(
      `Invalid job.json at ${jobPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

export async function createPendingSlideJob(input: CreateSlideJobInput): Promise<SlideJob> {
  const now = new Date();
  const id = newJobId(now);
  const pendingDir = path.join(jobsRoot, "pending", id);
  const completedDir = path.join(jobsRoot, "completed", id);

  const job: SlideJob = {
    id,
    url: input.url,
    urls: input.urls,
    researchPrompt: input.researchPrompt,
    sourceText: input.sourceText,
    sourceTitle: input.sourceTitle,
    audience: input.audience,
    focus: input.focus,
    pages: input.pages,
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
  assertSafeJobId(jobId);

  for (const status of statusDirs) {
    const dir = path.join(jobsRoot, status, jobId);
    const jobPath = path.join(dir, "job.json");

    if (existsSync(jobPath)) {
      const job = parseSlideJobFile(await readFile(jobPath, "utf8"), jobPath);
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
  await writeJobJson(dir, job);
}

function isBusyError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EBUSY";
}
