import { processSlideJob } from "../domains/slides/slideJobProcessor.js";
import { usage } from "./lib/cli.js";

const jobId = process.argv[2];
const explicitSlideDataPath = process.argv[3];

if (!jobId) {
  usage("Usage: npm run jobs:process -- <jobId> [path-to-slideData.json]");
}

const result = await processSlideJob(jobId, {
  slideDataPath: explicitSlideDataPath
});

console.log(JSON.stringify(result, null, 2));
