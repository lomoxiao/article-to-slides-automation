import { getDb } from "./firebaseAdmin.js";
import type { HomeworkJob, HomeworkJobStatus } from "../types/homework.js";

export const INTERRUPTED_HOMEWORK_STATUSES = [
  "downloading", "analyzing", "validating", "scenario_generating", "scenario_validating"
] as const satisfies readonly HomeworkJobStatus[];

export const INTERRUPTION_ERROR = "前回のWorker終了により処理を中断しました。新しいjobとして再投稿してください。";

export function failInterruptedJob(job: HomeworkJob | null, status: HomeworkJobStatus, now: string): HomeworkJob | null | undefined {
  if (job === null) return null;
  if (job.status !== status) return undefined;
  return { ...job, status: "failed", stage: "failed", error: INTERRUPTION_ERROR, updatedAt: now };
}

export async function finalizeInterruptedHomeworkJobs(now = new Date().toISOString()): Promise<number> {
  let finalized = 0;
  for (const status of INTERRUPTED_HOMEWORK_STATUSES) {
    const snapshot = await getDb().ref("/homeworkJobs").orderByChild("status").equalTo(status).get();
    for (const jobId of Object.keys((snapshot.val() as Record<string, HomeworkJob> | null) ?? {})) {
      const result = await getDb().ref(`/homeworkJobs/${jobId}`).transaction((job: HomeworkJob | null) => failInterruptedJob(job, status, now));
      if (result.committed) finalized += 1;
    }
  }
  return finalized;
}
