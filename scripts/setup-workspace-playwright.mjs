import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const automationDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = resolve(automationDir, "..");
const viewerDir = resolve(workspaceDir, "multimodal-article-viewer");
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("npm_execpath is unavailable; run this script through npm run playwright:setup");
}

run(["run", "playwright:install"], automationDir);
run(["run", "playwright:verify"], automationDir);

if (existsSync(resolve(viewerDir, "package.json"))) {
  run(["run", "playwright:install"], viewerDir);
  run(["run", "playwright:verify"], viewerDir);
} else {
  console.log("multimodal-article-viewer is not present; viewer verification skipped.");
}

console.log("Playwright Chromium setup completed.");

function run(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    stdio: "inherit",
    shell: false,
    env: process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}
