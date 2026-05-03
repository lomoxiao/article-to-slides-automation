import { readFile } from "node:fs/promises";
import { createSlidesViaGas } from "../services/gasSlides.js";

const slideDataPath = process.argv[2];

if (!slideDataPath) {
  throw new Error("Usage: npm run slides:create:gas -- <path-to-slideData.json>");
}

const raw = await readFile(slideDataPath, "utf8");
const slideData = JSON.parse(raw);

if (!Array.isArray(slideData)) {
  throw new Error("slideData JSON must be an array.");
}

console.log(JSON.stringify(await createSlidesViaGas(slideData), null, 2));
