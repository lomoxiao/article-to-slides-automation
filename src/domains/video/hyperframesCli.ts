import { access } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { spawnCli, type CliRunResult } from "../../shared/cliProcess.js";

export const HYPERFRAMES_VERSION = "0.7.87";
const cliEntry = path.resolve("node_modules", "hyperframes", "bin", "hyperframes.mjs");

export class HyperframesProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HyperframesProjectValidationError";
  }
}

async function run(args: string[], timeoutMs = config.video.jobTimeoutMs, allowNonZero = false): Promise<CliRunResult> {
  await access(cliEntry);
  const result = await spawnCli(process.execPath, [cliEntry, ...args], {
    timeoutMs,
    killTree: true,
    shell: false,
    timeoutError: () => new Error(`hyperframes ${args[0]} timed out after ${timeoutMs}ms`)
  });
  if (result.exitCode !== 0 && !allowNonZero) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`hyperframes ${args[0]} failed with exit code ${result.exitCode}: ${detail}`);
  }
  return result;
}

export async function lintProject(projectDir: string): Promise<void> {
  const result = await run(["lint", projectDir, "--json"], config.video.jobTimeoutMs, true);
  assertProjectValidationResult("lint", result);
}

export async function checkProject(projectDir: string, sceneMidpoints: number[]): Promise<void> {
  const at = sceneMidpoints.map((value) => value.toFixed(3)).join(",");
  const result = await run(["check", projectDir, "--json", "--strict", "--at", at, "--at-transitions"], config.video.jobTimeoutMs, true);
  assertProjectValidationResult("check", result);
}

function assertProjectValidationResult(command: "lint" | "check", result: CliRunResult): void {
  if (result.exitCode === 0) return;
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  const isValidationReport = isHyperframesProjectValidationOutput(command, result.stdout);
  if (isValidationReport) {
    throw new HyperframesProjectValidationError(`hyperframes ${command} rejected project: ${detail}`);
  }
  throw new Error(`hyperframes ${command} failed outside project validation with exit code ${result.exitCode}: ${detail}`);
}

export function isHyperframesProjectValidationOutput(command: "lint" | "check", output: string): boolean {
  const report = parseJsonReport(output) as Record<string, unknown> | undefined;
  return report?.ok === false && (command === "lint"
    ? Array.isArray(report.findings)
    : ["lint", "runtime", "layout", "motion", "contrast"].some((key) => key in report));
}

function parseJsonReport(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(output.slice(start, end + 1)); } catch { return undefined; }
}

export async function snapshotProject(projectDir: string, outputDir: string, sceneMidpoints: number[]): Promise<void> {
  await run(["snapshot", projectDir, "--output", outputDir, "--at", sceneMidpoints.map((value) => value.toFixed(3)).join(","), "--no-end"]);
}

export async function renderProject(projectDir: string, outputPath: string): Promise<void> {
  await run(["render", projectDir, "--output", outputPath, "--fps", "30", "--quality", "standard", "--workers", "1", "--strict", "--resolution", "landscape"]);
  await access(outputPath);
}

export async function doctor(): Promise<unknown> {
  const result = await run(["doctor", "--json"], 120_000, true);
  const report = JSON.parse(result.stdout) as { checks?: Array<{ name?: string; ok?: boolean; detail?: string }> };
  const required = new Set(["Node.js", "FFmpeg", "FFprobe", "Chrome"]);
  const missing = (report.checks ?? []).filter((check) => required.has(check.name ?? "") && !check.ok);
  if (missing.length > 0) throw new Error(`HyperFrames doctor failed required checks: ${missing.map((check) => `${check.name}: ${check.detail}`).join("; ")}`);
  return report;
}

export async function ensureBrowser(): Promise<void> {
  await run(["browser", "ensure"], 600_000);
}
