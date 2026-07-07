import formBody from "@fastify/formbody";
import Fastify from "fastify";
import { config } from "./config.js";
import { registerSlackRoutes } from "./routes/slack.js";
import { startSlackSocketModeClient } from "./slack/socketModeClient.js";

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

await app.listen({
  port: config.PORT,
  host: "0.0.0.0"
});
