import type { DataSnapshot, Query } from "firebase-admin/database";
import { getDb } from "./firebaseAdmin.js";
import { deleteHomeworkImage } from "./homeworkDriveService.js";
import type { HomeworkJob } from "../types/homework.js";

const activeJobs = new Set<string>();

export function startHomeworkDeletionWorker(): () => void {
  const root = getDb().ref("/homeworkJobs");
  const queries = ["delete_requested", "deleting"].map((status) => root.orderByChild("status").equalTo(status));
  const listener = (snapshot: DataSnapshot) => {
    const job = snapshot.val() as HomeworkJob | null;
    if (!job || activeJobs.has(job.id)) return;
    activeJobs.add(job.id);
    processHomeworkDeletion(job).catch((error) => {
      console.error(`[homework-delete] ${job.id}:`, error);
    }).finally(() => activeJobs.delete(job.id));
  };
  for (const query of queries) query.on("child_added", listener);
  return () => {
    for (const query of queries) query.off("child_added", listener);
  };
}

export async function processHomeworkDeletion(
  job: HomeworkJob,
  dependencies: {
    deleteDriveFile: (fileId: string) => Promise<void>;
    updateJob: (id: string, patch: Record<string, unknown>) => Promise<void>;
    removeJob: (id: string) => Promise<void>;
  } = defaultDependencies
): Promise<void> {
  try {
    await dependencies.updateJob(job.id, { status: "deleting", stage: "deleting", error: null, updatedAt: new Date().toISOString() });
    if (job.sourceImage?.provider === "google_drive") await dependencies.deleteDriveFile(job.sourceImage.fileId);
    await dependencies.removeJob(job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dependencies.updateJob(job.id, { status: "delete_failed", stage: "delete_failed", error: message, updatedAt: new Date().toISOString() });
    throw error;
  }
}

const defaultDependencies = {
  deleteDriveFile: deleteHomeworkImage,
  updateJob: async (id: string, patch: Record<string, unknown>) => { await getDb().ref(`/homeworkJobs/${id}`).update(patch); },
  removeJob: async (id: string) => { await getDb().ref(`/homeworkJobs/${id}`).remove(); }
};
