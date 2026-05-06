import type { FastifyInstance } from "fastify";
import { processSlideJob } from "../services/slideJobProcessor.js";
import { runUrlToGasSlidesWorkflow } from "../workflows/urlToGasSlides.js";
import { parseSlideArgs } from "../utils/parseSlideArgs.js";

type SlackSlashCommandPayload = {
  text?: string;
  user_id?: string;
  channel_id?: string;
  response_url?: string;
};

export async function registerSlackRoutes(app: FastifyInstance) {
  app.post<{ Body: SlackSlashCommandPayload }>("/slack/commands/slides", async (request, reply) => {
    const slideArgs = parseSlideArgs(request.body.text ?? "");

    if (!slideArgs.ok) {
      return reply.send({
        response_type: "ephemeral",
        text: slideArgs.errorMessage
      });
    }

    const job = await runUrlToGasSlidesWorkflow({
      urls: slideArgs.urls,
      researchPrompt: slideArgs.researchPrompt,
      audience: slideArgs.audience,
      focus: slideArgs.focus,
      pages: slideArgs.pages,
      requestedBy: request.body.user_id,
      sourceChannelId: request.body.channel_id
    });

    processSlideJob(job.id).catch((error) => {
      request.log.error(
        {
          error,
          urls: slideArgs.urls,
          researchPrompt: slideArgs.researchPrompt,
          jobId: job.id
        },
        "Automatic URL to GAS slides workflow failed"
      );
    });

    return reply.send({
      response_type: "ephemeral",
      text: `スライド生成ジョブを受け付けました。完了後に通知します。\nJob ID: ${job.id}`
    });
  });
}
