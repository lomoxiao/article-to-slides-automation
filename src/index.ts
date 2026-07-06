import formBody from "@fastify/formbody";
import Fastify from "fastify";
import { config } from "./config.js";
import { registerSlackRoutes } from "./routes/slack.js";
import { startSlackSocketModeClient } from "./slack/socketModeClient.js";
import { startHomeworkDeletionWorker } from "./services/homeworkDeletionWorker.js";
import { finalizeInterruptedHomeworkJobs } from "./services/homeworkJobLifecycle.js";
import { startScenarioQueueWorker } from "./services/homeworkScenarioWorker.js";
import { startWebHomeworkQueueWorker } from "./services/homeworkJobService.js";

const app = Fastify({
  logger: true
});

await app.register(formBody);

app.get("/health", async () => ({ ok: true }));

if (config.SLACK_APP_TOKEN) {
  await startSlackSocketModeClient();
  app.log.info("Slack Socket Mode client started");
  const finalizedJobs = await finalizeInterruptedHomeworkJobs();
  app.log.info({ finalizedJobs }, "Interrupted homework jobs finalized as failed");
  startWebHomeworkQueueWorker();
  startScenarioQueueWorker();
  app.log.info("Web homework Firebase queue worker started");
} else {
  await registerSlackRoutes(app);
  app.log.info("SLACK_APP_TOKEN is not set; using legacy Slack HTTP webhook route");
}

if (config.HOMEWORK_DRIVE_FOLDER_ID && config.HOMEWORK_OWNER_UID) {
  startHomeworkDeletionWorker();
  app.log.info("Homework Drive deletion worker started");
}

await app.listen({
  port: config.PORT,
  host: "0.0.0.0"
});
