import { stat } from "node:fs/promises";
import path from "node:path";
import { validateFinalVideo } from "../domains/video/media.js";
import { listVideoJobs, updateVideoJob } from "../domains/video/videoJobStore.js";

const applyChanges = process.argv.includes("--apply");
const jobs = (await listVideoJobs()).filter(
  (job) => job.requestedBy === "cli" && (job.status === "pending" || job.status === "processing"),
);

let completed = 0;
let failed = 0;

for (const job of jobs) {
  const outputPath = path.join(job.jobDir, "output.mp4");
  let validOutput = false;

  try {
    const output = await stat(outputPath);
    if (output.isFile() && output.size > 0) {
      await validateFinalVideo(outputPath);
      validOutput = true;
    }
  } catch {
    validOutput = false;
  }

  const nextStatus = validOutput ? "completed" : "failed";
  console.log(`${applyChanges ? "UPDATE" : "DRY-RUN"} ${job.id}: ${nextStatus}`);

  if (validOutput) completed += 1;
  else failed += 1;
  if (!applyChanges) continue;

  await updateVideoJob(
    job,
    validOutput
      ? {
          executionMode: "cli",
          status: "completed",
          errorCode: undefined,
          error: undefined,
        }
      : {
          executionMode: "cli",
          status: "failed",
          errorCode: "LEGACY_CLI_JOB_INCOMPLETE",
          error: "Legacy CLI validation job did not produce a valid completed MP4",
        },
  );
}

console.log(JSON.stringify({ apply: applyChanges, candidates: jobs.length, completed, failed }, null, 2));
