import type { FastifyInstance } from "fastify";
import { processSlideJob } from "../services/slideJobProcessor.js";
import { runUrlToGasSlidesWorkflow } from "../workflows/urlToGasSlides.js";
import { extractFirstUrl } from "../utils/url.js";

type SlackSlashCommandPayload = {
  text?: string;
  user_id?: string;
  channel_id?: string;
  response_url?: string;
};

export async function registerSlackRoutes(app: FastifyInstance) {
  app.post<{ Body: SlackSlashCommandPayload }>("/slack/commands/slides", async (request, reply) => {
    const url = extractFirstUrl(request.body.text ?? "");

    if (!url) {
      return reply.send({
        response_type: "ephemeral",
        text: "URLを見つけられませんでした。`/slides https://example.com/article` の形式で送ってください。"
      });
    }

    const job = await runUrlToGasSlidesWorkflow({
      url,
      requestedBy: request.body.user_id,
      sourceChannelId: request.body.channel_id
    });

    processSlideJob(job.id).catch((error) => {
      request.log.error({ error, url, jobId: job.id }, "Automatic URL to GAS slides workflow failed");
    });

    return reply.send({
      response_type: "ephemeral",
      text: `スライド生成ジョブを受け付けました。完了後に通知します。\nJob ID: ${job.id}`
    });
  });
}
