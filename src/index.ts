import formBody from "@fastify/formbody";
import Fastify from "fastify";
import { config } from "./config.js";
import { registerSlackRoutes } from "./routes/slack.js";
import { startSlackSocketModeClient } from "./slack/socketModeClient.js";
import { startGenerationRequestWatcher } from "./services/generationRequestWatcher.js";
import { reconcileSessionStatuses } from "./services/sessionStatusStore.js";

const app = Fastify({
  logger: true
});

await app.register(formBody);

app.get("/health", async () => ({ ok: true }));

if (config.SLACK_APP_TOKEN) {
  await startSlackSocketModeClient();
  app.log.info("Slack Socket Mode client started");
} else {
  await registerSlackRoutes(app);
  app.log.info("SLACK_APP_TOKEN is not set; using legacy Slack HTTP webhook route");
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
