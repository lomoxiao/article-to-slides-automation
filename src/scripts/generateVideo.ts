import { createVideoJob, readVideoJob, updateVideoJob } from "../domains/video/videoJobStore.js";
import { generateVideoLocally, uploadVideoOutputs } from "../domains/video/videoPipeline.js";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const url = urlIndex >= 0 ? args[urlIndex + 1] : args.find((value) => !value.startsWith("--"));
const motionIndex = args.indexOf("--motion");
const motionMode = motionIndex >= 0 ? args[motionIndex + 1] : undefined;
if (motionMode !== undefined && motionMode !== "basic" && motionMode !== "rich") {
  console.error("--motion must be basic or rich");
  process.exit(1);
}
if (!url) {
  console.error("Usage: npm run video:generate -- --url <article-url> [--motion basic|rich] [--upload]");
  process.exit(1);
}

const job = await createVideoJob({ url, motionMode, requestedBy: "cli", executionMode: "cli" });
try {
  const generated = await generateVideoLocally(job);
  if (args.includes("--upload")) {
    const uploaded = await uploadVideoOutputs(generated);
    const completed = await updateVideoJob(uploaded.job, { status: "completed" });
    console.log(JSON.stringify({
      jobId: completed.id,
      output: `${completed.jobDir}/output.mp4`,
      url: uploaded.url
    }, null, 2));
  } else {
    const completed = await updateVideoJob(generated, { status: "completed" });
    console.log(JSON.stringify({
      jobId: completed.id,
      output: `${completed.jobDir}/output.mp4`
    }, null, 2));
  }
} catch (error) {
  const current = await readVideoJob(job.id) ?? job;
  await updateVideoJob(current, {
    status: "failed",
    errorCode: "CLI_VIDEO_GENERATION_FAILED",
    error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
  });
  throw error;
}
