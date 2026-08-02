import { createVideoJob } from "../domains/video/videoJobStore.js";
import { generateVideoLocally, uploadVideoOutputs } from "../domains/video/videoPipeline.js";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const url = urlIndex >= 0 ? args[urlIndex + 1] : args.find((value) => !value.startsWith("--"));
if (!url) {
  console.error("Usage: npm run video:generate -- --url <article-url> [--upload]");
  process.exit(1);
}
const job = await createVideoJob({ url, requestedBy: "cli" });
const generated = await generateVideoLocally(job);
if (args.includes("--upload")) {
  const uploaded = await uploadVideoOutputs(generated);
  console.log(JSON.stringify({ jobId: uploaded.job.id, output: `${uploaded.job.jobDir}/output.mp4`, url: uploaded.url }, null, 2));
} else {
  console.log(JSON.stringify({ jobId: generated.id, output: `${generated.jobDir}/output.mp4` }, null, 2));
}
