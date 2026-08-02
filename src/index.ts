import Fastify from "fastify";
import { config } from "./config.js";
import { startSlackSocketModeClient } from "./slack/socketModeClient.js";
import { startGenerationRequestWatcher } from "./domains/slides/generationRequestWatcher.js";
import { reconcileSessionStatuses } from "./shared/sessionStatusStore.js";
import { markInterruptedVideoJobs } from "./domains/video/videoGenerationQueue.js";
import { refreshSlidesRuntimeReadiness } from "./domains/slides/playwrightPreflight.js";

const app = Fastify({
  logger: true
});

app.get("/health", async () => ({ ok: true }));

const slidesRuntime = await refreshSlidesRuntimeReadiness();
if (slidesRuntime.status === "available") {
  app.log.info("Playwright Chromium preflight passed");
} else {
  app.log.warn(`Playwright Chromium preflight failed; slides requests will be rejected safely: ${slidesRuntime.detail}`);
}

try {
  const result = await markInterruptedVideoJobs();
  if (result.total > 0) app.log.info(
    "Marked " + result.total + " interrupted video job(s) action_required (managed=" + result.managed + ", cli=" + result.cli + ", failed=" + result.failed + ")"
  );
} catch (error) {
  app.log.warn("Interrupted video job reconciliation skipped: " + (error instanceof Error ? error.message : String(error)));
}


// Slack 入力は Socket Mode のみ。旧 HTTP webhook 経路(routes/slack.ts)は
// 署名検証が無く未使用だったため 2026-07 に削除した(必要なら git 履歴から復元)。
if (config.slack.appToken) {
  await startSlackSocketModeClient();
  app.log.info("Slack Socket Mode client started");
} else {
  app.log.warn("SLACK_APP_TOKEN is not set; Slack input is disabled");
}

try {
  startGenerationRequestWatcher();
  app.log.info("Generation request watcher started");
} catch (error) {
  app.log.warn(
    `Generation request watcher not started (Firebase credentials missing?): ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

reconcileSessionStatuses().catch((error) => {
  app.log.warn(
    `Session status reconcile skipped: ${error instanceof Error ? error.message : String(error)}`
  );
});

await app.listen({
  port: config.server.port,
  host: "0.0.0.0"
});
