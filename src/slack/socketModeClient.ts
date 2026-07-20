import { SocketModeClient } from "@slack/socket-mode";
import { config } from "../config.js";
import { notifySlackJobFailed, postSlackText } from "../shared/slackNotifier.js";
import { processSlideJob } from "../domains/slides/slideJobProcessor.js";
import { runUrlToGasSlidesWorkflow } from "../workflows/urlToGasSlides.js";
import { parseSlideArgs } from "../utils/parseSlideArgs.js";
import { parseMangaSlackArgs } from "../utils/parseMangaSlackArgs.js";
import { enqueueMangaGeneration } from "../domains/manga/mangaGenerationQueue.js";
import {
  MANGA_GENERATE_PREFIX,
  SLIDE_GENERATE_PREFIX,
  describeSlackMessageEvent,
  getErrorCode,
  getRequestId,
  isChannelAllowed,
  isGenerateMessage,
  stripPrefix,
  type SlackMessageEvent
} from "./messageGate.js";
import { RecentRequestIds } from "./recentRequestIds.js";

const MANGA_ACCEPTED_TEXT = "漫画生成リクエストを受け付けました。完了後に通知します（生成に数分かかります）。";
const processedSlideRequestIds = new RecentRequestIds();
const processedMangaRequestIds = new RecentRequestIds();

type SlashCommandPayload = {
  text?: string;
  user_id?: string;
  channel_id?: string;
  command?: string;
};

type SlashCommandEnvelope = {
  body?: SlashCommandPayload;
  ack: (response?: unknown) => Promise<void>;
};

type EventsApiEnvelope = {
  event?: SlackMessageEvent;
  body?: {
    event?: SlackMessageEvent;
    event_id?: string;
  };
  ack: () => Promise<void>;
};

type SlackAck = (response?: unknown) => Promise<void>;

type EnqueueSlideGenerationInput = {
  urls?: string[];
  researchPrompt?: string;
  audience?: string;
  focus?: string;
  pages?: number;
  requestedBy?: string;
  sourceChannelId?: string;
};

export async function startSlackSocketModeClient() {
  if (!config.slack.appToken) {
    throw new Error("SLACK_APP_TOKEN is required to start Slack Socket Mode");
  }

  const client = new SocketModeClient({
    appToken: config.slack.appToken
  });

  client.on("slash_commands", async ({ body, ack }: SlashCommandEnvelope) => {
    if (body?.command && body.command !== "/slides") {
      await ack();
      return;
    }

    const slideArgs = parseSlideArgs(body?.text ?? "");

    if (!slideArgs.ok) {
      await ack({
        response_type: "ephemeral",
        text: slideArgs.errorMessage
      });
      return;
    }

    let jobId: string | undefined;

    try {
      jobId = await enqueueSlideGeneration({
        urls: slideArgs.urls,
        researchPrompt: slideArgs.researchPrompt,
        audience: slideArgs.audience,
        focus: slideArgs.focus,
        pages: slideArgs.pages,
        requestedBy: body?.user_id,
        sourceChannelId: body?.channel_id
      });

      await ack({
        response_type: "ephemeral",
        text: `スライド生成ジョブを受け付けました。完了後に通知します。\nJob ID: ${jobId}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ack({
        response_type: "ephemeral",
        text: `スライド生成ジョブの作成に失敗しました。\n${message}`
      });

      await notifySlackJobFailed({
        channelId: body?.channel_id,
        requestedBy: body?.user_id,
        jobId,
        error: message
      });
    }
  });

  client.on("message", async ({ event, body, ack }: EventsApiEnvelope) => {
    const messageEvent = event ?? body?.event;
    const eventDescription = describeSlackMessageEvent(messageEvent);

    try {
      await safeAck(ack, eventDescription);

      if (!messageEvent) {
        return;
      }

      if (isGenerateMessage(messageEvent, MANGA_GENERATE_PREFIX, config.slack.completionChannelId)) {
        await handleMangaGenerateMessage(messageEvent);
        return;
      }

      logSlideGenerateEventDecision(messageEvent);

      if (!isGenerateMessage(messageEvent, SLIDE_GENERATE_PREFIX, config.slack.completionChannelId)) {
        return;
      }

      const requestId = getRequestId(messageEvent);
      if (processedSlideRequestIds.has(requestId)) {
        return;
      }
      processedSlideRequestIds.remember(requestId);

      const slideArgs = parseSlideArgs(stripPrefix(messageEvent.text ?? "", SLIDE_GENERATE_PREFIX));
      if (!slideArgs.ok) {
        await postSlackText({
          channelId: messageEvent.channel,
          text: slideArgs.errorMessage
        });
        return;
      }

      try {
        const jobId = await enqueueSlideGeneration({
          urls: slideArgs.urls,
          researchPrompt: slideArgs.researchPrompt,
          audience: slideArgs.audience,
          focus: slideArgs.focus,
          pages: slideArgs.pages,
          requestedBy: messageEvent.user,
          sourceChannelId: messageEvent.channel
        });

        await postSlackText({
          channelId: messageEvent.channel,
          text: `スライド生成リクエストを受け付けました。Job ID: ${jobId}`
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to enqueue slide generation from message event: ${message}`);
        await notifySlackJobFailed({
          channelId: messageEvent.channel,
          requestedBy: messageEvent.user,
          error: message
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Slack message handler failed (${eventDescription}): ${message}`);
      return;
    }
  });

  await client.start();
  return client;
}

async function enqueueSlideGeneration(input: EnqueueSlideGenerationInput): Promise<string> {
  const job = await runUrlToGasSlidesWorkflow(input);

  processSlideJob(job.id).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Automatic slide job failed: ${message}`);
  });

  return job.id;
}

async function safeAck(ack: SlackAck, eventDescription: string): Promise<boolean> {
  try {
    await ack();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = getErrorCode(error);
    console.warn(`Slack ack failed (${eventDescription}) code=${code}: ${message}`);
    return false;
  }
}

async function handleMangaGenerateMessage(event: SlackMessageEvent): Promise<void> {
  const requestId = getRequestId(event);
  if (processedMangaRequestIds.has(requestId)) {
    return;
  }
  processedMangaRequestIds.remember(requestId);

  const mangaArgs = parseMangaSlackArgs(stripPrefix(event.text ?? "", MANGA_GENERATE_PREFIX));
  if (!mangaArgs.ok) {
    await postSlackText({ channelId: event.channel, text: mangaArgs.errorMessage });
    return;
  }

  enqueueMangaGeneration({
    url: mangaArgs.url,
    pages: mangaArgs.pages,
    genre: mangaArgs.genre,
    artStyle: mangaArgs.artStyle,
    treatment: mangaArgs.treatment,
    audience: mangaArgs.audience,
    focus: mangaArgs.focus,
    requestedBy: event.user,
    sourceChannelId: event.channel
  });

  await postSlackText({ channelId: event.channel, text: MANGA_ACCEPTED_TEXT });
}

function logSlideGenerateEventDecision(event: SlackMessageEvent | undefined) {
  if (!event) {
    console.log("[slide-generate] ignored: no Slack event payload");
    return;
  }

  if (event.type !== "message") {
    console.log(`[slide-generate] ignored: event type is ${event.type ?? "unknown"}`);
    return;
  }

  const text = event.text?.trim() ?? "";
  const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;

  if (!text.startsWith(SLIDE_GENERATE_PREFIX)) {
    if (!text.toLowerCase().includes("slide-generate")) {
      return;
    }

    console.log(
      `[slide-generate] ignored: prefix mismatch channel=${event.channel ?? "unknown"} subtype=${event.subtype ?? "none"} text=${JSON.stringify(preview)}`
    );
    return;
  }

  if (!event.channel) {
    console.log("[slide-generate] ignored: missing channel");
    return;
  }

  if (!isChannelAllowed(event.channel, config.slack.completionChannelId)) {
    console.log(
      `[slide-generate] ignored: channel mismatch received=${event.channel} expected=${config.slack.completionChannelId ?? "unset"}`
    );
    return;
  }

  if (event.subtype && event.subtype !== "bot_message") {
    console.log(`[slide-generate] ignored: unsupported subtype=${event.subtype}`);
    return;
  }

  const args = parseSlideArgs(stripPrefix(text, SLIDE_GENERATE_PREFIX));
  if (!args.ok) {
    console.log(`[slide-generate] accepted with parse error: ${args.errorMessage} text=${JSON.stringify(preview)}`);
    return;
  }

  console.log(
    `[slide-generate] accepted: channel=${event.channel} subtype=${event.subtype ?? "none"} user=${event.user ?? "unknown"} bot=${event.bot_id ?? "none"}`
  );
}
