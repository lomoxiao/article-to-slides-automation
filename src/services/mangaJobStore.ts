import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CreateMangaJobInput, MangaJob } from "../types/manga.js";
import { isSafeJobId } from "../utils/safeJobId.js";

const jobsRoot = path.join("jobs", "manga");

// job.json は外部から書き換え可能なファイルのため、読み込み時に必ず検証する。
// 必須はジョブ生成時に必ず書かれる8フィールドのみとし、それ以外の進行状態
// フィールドと未知キーは passthrough で保持する(後方互換・前方互換)。
const mangaJobSchema = z.object({
  id: z.string(),
  url: z.string(),
  pages: z.number(),
  artStyle: z.string(),
  treatment: z.enum(["A", "B", "C"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  jobDir: z.string()
}).passthrough();

function parseMangaJobFile(raw: string, jobPath: string): MangaJob {
  try {
    return mangaJobSchema.parse(JSON.parse(raw)) as MangaJob;
  } catch (error) {
    throw new Error(
      `Invalid job.json at ${jobPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

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

/**
 * 既存ジョブを job.json から読み出す(manga:resume 用)。不正な ID・ファイル無しは
 * undefined。job.json が存在するのに壊れている場合は(黙って未発見扱いにせず)throw する。
 */
export async function readMangaJob(jobId: string): Promise<MangaJob | undefined> {
  if (!isSafeJobId(jobId)) {
    return undefined;
  }

  const jobPath = path.join(jobsRoot, jobId, "job.json");
  let raw: string;
  try {
    raw = await readFile(jobPath, "utf8");
  } catch {
    return undefined;
  }
  return parseMangaJobFile(raw, jobPath);
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
