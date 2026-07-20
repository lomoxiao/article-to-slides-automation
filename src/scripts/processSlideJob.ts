import { processSlideJob } from "../domains/slides/slideJobProcessor.js";

const jobId = process.argv[2];
const explicitSlideDataPath = process.argv[3];

if (!jobId) {
  throw new Error("Usage: npm run jobs:process -- <jobId> [path-to-slideData.json]");
}

const result = await processSlideJob(jobId, {
  slideDataPath: explicitSlideDataPath
});

console.log(JSON.stringify(result, null, 2));
