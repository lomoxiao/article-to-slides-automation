import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CreateMangaJobInput, MangaJob } from "../types/manga.js";

const jobsRoot = path.join("jobs", "manga");

/**
 * manga ジョブを作成する。
 * スライドジョブ(jobStore.ts)の status ディレクトリ遷移とは異なり、
 * manga は jobs/manga/[id]/ 配下に固定の作業フォルダを用意するだけのシンプルな構成。
 */
export async function createMangaJob(input: CreateMangaJobInput): Promise<MangaJob> {
  const now = new Date();
  const id = `${formatJobTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const jobDir = path.join(jobsRoot, id);

  const job: MangaJob = {
    ...input,
    id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    jobDir,
    uploadDir: path.join(jobDir, "upload")
  };

  await mkdir(path.join(jobDir, "character-sheets"), { recursive: true });
  await mkdir(path.join(jobDir, "upload"), { recursive: true });
  await mkdir(path.join(jobDir, "output"), { recursive: true });
  await writeJobFile(job);

  return job;
}

/** 既存ジョブを job.json から読み出す(manga:resume 用)。見つからなければ undefined。 */
export async function readMangaJob(jobId: string): Promise<MangaJob | undefined> {
  try {
    const raw = await readFile(path.join(jobsRoot, jobId, "job.json"), "utf8");
    return JSON.parse(raw) as MangaJob;
  } catch {
    return undefined;
  }
}

export async function updateMangaJob(job: MangaJob, patch: Partial<MangaJob>): Promise<MangaJob> {
  const nextJob: MangaJob = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await writeJobFile(nextJob);
  return nextJob;
}

async function writeJobFile(job: MangaJob) {
  await mkdir(job.jobDir, { recursive: true });
  await writeFile(path.join(job.jobDir, "job.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

function formatJobTimestamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
