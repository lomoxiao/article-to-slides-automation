import Fastify from "fastify";
import { config } from "./config.js";
import { startSlackSocketModeClient } from "./slack/socketModeClient.js";
import { startGenerationRequestWatcher } from "./services/generationRequestWatcher.js";
import { reconcileSessionStatuses } from "./services/sessionStatusStore.js";

const app = Fastify({
  logger: true
});

app.get("/health", async () => ({ ok: true }));

// Slack 入力は Socket Mode のみ。旧 HTTP webhook 経路(routes/slack.ts)は
// 署名検証が無く未使用だったため 2026-07 に削除した(必要なら git 履歴から復元)。
if (config.SLACK_APP_TOKEN) {
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
  port: config.PORT,
  host: "0.0.0.0"
});
