import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSlidesViaGas } from "../domains/slides/gasSlides.js";
import { renderChartImagesInSlideData } from "../domains/slides/chartRenderer.js";

const slideDataPath = process.argv[2];

if (!slideDataPath) {
  throw new Error("Usage: npm run slides:create:gas -- <path-to-slideData.json>");
}

const raw = await readFile(slideDataPath, "utf8");
const slideData = JSON.parse(raw);

if (!Array.isArray(slideData)) {
  throw new Error("slideData JSON must be an array.");
}

const renderedSlideData = await renderChartImagesInSlideData(slideData);
const renderedSlideDataPath = path.join(path.dirname(slideDataPath), "slideData.rendered.json");
await writeFile(renderedSlideDataPath, `${JSON.stringify(renderedSlideData, null, 2)}\n`, "utf8");

console.log(JSON.stringify(await createSlidesViaGas(renderedSlideData), null, 2));
