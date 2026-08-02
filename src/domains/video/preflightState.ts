import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HYPERFRAMES_VERSION } from "./hyperframesCli.js";
import { KOKORO_JA_PROVIDER_ID } from "./narrationProvider.js";

const root = path.join("jobs", "video");
const browserMarker = path.join(root, ".browser-ready.json");
const runtimeMarker = path.join(root, ".runtime-ready.json");

export async function markVideoBrowserReady(): Promise<void> {
  await writeMarker(browserMarker, "browser");
}

export async function markVideoRuntimeReady(): Promise<void> {
  await writeMarker(runtimeMarker, "tts-and-captions", { ttsProvider: KOKORO_JA_PROVIDER_ID, pipelineVersion: "2" });
}

export async function assertVideoBrowserReady(): Promise<void> {
  await assertMarker(browserMarker, "Run: npm run video:browser:ensure", undefined, "browser");
}

export async function assertVideoRuntimeReady(): Promise<void> {
  await assertMarker(runtimeMarker, "Run: npm run video:preflight:smoke", KOKORO_JA_PROVIDER_ID, "tts-and-captions", "2");
}

async function writeMarker(markerPath: string, kind: string, extra: Record<string, string> = {}): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(markerPath, JSON.stringify({
    kind,
    hyperframesVersion: HYPERFRAMES_VERSION,
    ...extra,
    completedAt: new Date().toISOString()
  }, null, 2) + "\n", "utf8");
}

async function assertMarker(
  markerPath: string,
  hint: string,
  expectedTtsProvider?: string,
  expectedKind?: string,
  expectedPipelineVersion?: string
): Promise<void> {
  try {
    await access(markerPath);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { kind?: string; hyperframesVersion?: string; ttsProvider?: string; pipelineVersion?: string };
    if (marker.hyperframesVersion !== HYPERFRAMES_VERSION) throw new Error("version mismatch");
    if (expectedKind && marker.kind !== expectedKind) throw new Error("marker kind mismatch");
    if (expectedTtsProvider && marker.ttsProvider !== expectedTtsProvider) throw new Error("TTS provider mismatch");
    if (expectedPipelineVersion && marker.pipelineVersion !== expectedPipelineVersion) throw new Error("pipeline version mismatch");
  } catch {
    throw new Error(`VIDEO_PREFLIGHT_REQUIRED: ${hint}`);
  }
}
