import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// jobStore(スライド) / mangaJobStore(マンガ) で共用するジョブ永続化の下回り。
// ディレクトリ構成(status 遷移型 vs 固定フォルダ型)は各ストアの責務のまま残す。

/** 例: 20260720T123456Z-0f6e0c96 (UTC 秒精度タイムスタンプ + UUID 先頭8桁)。 */
export function newJobId(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

/** job.json を dir 直下へ整形付き(末尾改行あり)で書き出す。dir が無ければ作る。 */
export async function writeJobJson(dir: string, job: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "job.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}
