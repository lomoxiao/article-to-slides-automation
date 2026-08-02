import { writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnCli } from "../../shared/cliProcess.js";

type ProbeResult = {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
};

async function run(command: string, args: string[], timeoutMs = 600_000): Promise<string> {
  const result = await spawnCli(command, args, { timeoutMs, killTree: true, shell: false });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const output = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", filePath]);
  return JSON.parse(output) as ProbeResult;
}

export async function probeDuration(filePath: string): Promise<number> {
  const probe = await probeMedia(filePath);
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid media duration: ${filePath}`);
  return duration;
}

export async function applyAtempo(inputPath: string, outputPath: string, factor: number): Promise<void> {
  if (factor < 0.5 || factor > 2) throw new Error(`Unsupported atempo factor: ${factor}`);
  await run("ffmpeg", ["-y", "-i", inputPath, "-filter:a", `atempo=${factor.toFixed(6)}`, "-c:a", "pcm_s16le", outputPath]);
}

export async function concatWavFiles(inputs: string[], outputPath: string): Promise<void> {
  const listPath = path.join(path.dirname(outputPath), "concat.txt");
  const lines = inputs.map((input) => `file '${path.resolve(input).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
  await writeFile(listPath, `${lines.join("\n")}\n`, "utf8");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "pcm_s16le", outputPath]);
}

export async function validateFinalVideo(filePath: string): Promise<{ durationSec: number; width: number; height: number }> {
  const probe = await probeMedia(filePath);
  const durationSec = Number(probe.format?.duration);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (!Number.isFinite(durationSec) || durationSec < 55 || durationSec > 65) throw new Error(`DURATION_OUT_OF_RANGE: ${durationSec}`);
  if (video?.codec_name !== "h264" || video.width !== 1920 || video.height !== 1080) throw new Error("VIDEO_FORMAT_INVALID");
  if (audio?.codec_name !== "aac") throw new Error("AUDIO_FORMAT_INVALID");
  return { durationSec, width: video.width, height: video.height };
}
