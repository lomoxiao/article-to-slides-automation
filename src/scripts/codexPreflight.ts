import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { copySanitizedCodexConfig } from "../shared/codexConfig.js";

type VersionCheck = {
  ok: boolean;
  output: string;
};

type PreflightResult = {
  timestamp: string;
  resolvedCodexPath: string;
  checks: {
    pathNotWindowsApps: boolean;
    fileExists: boolean;
    versionCheck: VersionCheck;
    runnerHomeWritable: boolean;
    authJsonCopied: boolean;
    configTomlCopied: boolean;
  };
  ok: boolean;
};

const result = await runPreflight();
await writeFile("codex-preflight.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");

if (!result.ok) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));

async function runPreflight(): Promise<PreflightResult> {
  const runnerHome = path.resolve(config.CODEX_RUNNER_HOME);
  const sourceHome = path.resolve(config.CODEX_SOURCE_HOME ?? path.join(homedir(), ".codex"));
  await copyConfigFile(resolveExternalCodexPath(config.CODEX_CLI_COMMAND), path.join(runnerHome, "bin", "codex.exe"));
  const runnerHomeWritable = await checkRunnerHomeWritable(runnerHome);
  const authJsonCopied = await copyConfigFile(path.join(sourceHome, "auth.json"), path.join(runnerHome, "auth.json"));
  const configCopy = await copySanitizedCodexConfig(
    path.join(sourceHome, "config.toml"),
    path.join(runnerHome, "config.toml")
  );
  if (configCopy.removedServiceTier !== undefined) {
    console.warn(
      `[codex:preflight] Ignored unsupported top-level service_tier=${JSON.stringify(configCopy.removedServiceTier)}.`
    );
  }
  const resolvedCodexPath = resolveCodexPath(config.CODEX_CLI_COMMAND);
  const pathNotWindowsApps = !resolvedCodexPath.toLowerCase().includes("\\windowsapps\\");
  const fileExists = Boolean(resolvedCodexPath) && existsSync(resolvedCodexPath);
  const versionCheck = fileExists
    ? await runVersionCheck(resolvedCodexPath, runnerHome)
    : { ok: false, output: "codex executable was not found." };
  const configTomlCopied = configCopy.copied;

  const checks = {
    pathNotWindowsApps,
    fileExists,
    versionCheck,
    runnerHomeWritable,
    authJsonCopied,
    configTomlCopied
  };

  return {
    timestamp: new Date().toISOString(),
    resolvedCodexPath,
    checks,
    ok:
      checks.pathNotWindowsApps &&
      checks.fileExists &&
      checks.versionCheck.ok &&
      checks.runnerHomeWritable &&
      checks.authJsonCopied &&
      checks.configTomlCopied
  };
}

function resolveCodexPath(command: string) {
  const runnerCodex = path.resolve(config.CODEX_RUNNER_HOME, "bin", "codex.exe");
  if (process.platform === "win32" && existsSync(runnerCodex)) {
    return runnerCodex;
  }

  if (command !== "codex") {
    return command;
  }

  const candidates = [
    ...getUserCodexCandidates()
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? command;
}

function resolveExternalCodexPath(command: string) {
  if (command !== "codex") {
    return command;
  }

  return getUserCodexCandidates().find((candidate) => existsSync(candidate)) ?? command;
}

function getUserCodexCandidates() {
  const userProfile = process.env.USERPROFILE;
  const localAppData = process.env.LOCALAPPDATA;

  return [
    path.join(homedir(), "AppData", "Local", "OpenAI", "Codex", "bin", "codex.exe"),
    userProfile ? path.join(userProfile, "AppData", "Local", "OpenAI", "Codex", "bin", "codex.exe") : undefined,
    localAppData ? path.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe") : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function runVersionCheck(codexPath: string, codexHome: string): Promise<VersionCheck> {
  const command = `& ${psSingleQuote(codexPath)} --version`;

  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome
      },
      windowsHide: true
    });

    let output = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      resolve({ ok: false, output: error.message });
    });

    child.on("close", (exitCode) => {
      resolve({ ok: exitCode === 0, output: output.trim() });
    });
  });
}

async function checkRunnerHomeWritable(runnerHome: string) {
  const testPath = path.join(runnerHome, ".preflight-write-test");

  try {
    await mkdir(runnerHome, { recursive: true });
    await writeFile(testPath, "ok", "utf8");
    await rm(testPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function copyConfigFile(source: string, destination: string) {
  try {
    if (!existsSync(source)) {
      return false;
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return true;
  } catch {
    return false;
  }
}

function psSingleQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}
