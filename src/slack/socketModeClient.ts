import { SocketModeClient } from "@slack/socket-mode";
import { config } from "../config.js";
import { notifySlackJobFailed, postSlackText } from "../services/slackNotifier.js";
import { processSlideJob } from "../services/slideJobProcessor.js";
import { runUrlToGasSlidesWorkflow } from "../workflows/urlToGasSlides.js";
import { parseSlideArgs } from "../utils/parseSlideArgs.js";
import { parseMangaSlackArgs } from "../utils/parseMangaSlackArgs.js";
import { enqueueMangaGeneration } from "../services/mangaGenerationQueue.js";
import { enqueueHomeworkMessage, isHomeworkMessage, parseWebHomeworkTrigger, processWebHomeworkJob } from "../services/homeworkJobService.js";
import type { SlackHomeworkFile } from "../types/homework.js";

const SLIDE_GENERATE_PREFIX = "[slide-generate]";
const MANGA_GENERATE_PREFIX = "[manga-generate]";
const MANGA_ACCEPTED_TEXT = "漫画生成リクエストを受け付けました。完了後に通知します（生成に数分かかります）。";
const MAX_PROCESSED_REQUEST_IDS = 500;
const processedSlideRequestIds = new Set<string>();
const processedMangaRequestIds = new Set<string>();

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

type SlackMessageEvent = {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  ts?: string;
  client_msg_id?: string;
  files?: SlackHomeworkFile[];
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
  if (!config.SLACK_APP_TOKEN) {
    throw new Error("SLACK_APP_TOKEN is required to start Slack Socket Mode");
  }

  const client = new SocketModeClient({
    appToken: config.SLACK_APP_TOKEN
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

      const webHomeworkJobId = parseWebHomeworkTrigger(messageEvent.text);
      if (webHomeworkJobId && messageEvent.channel === config.SLACK_HOMEWORK_CHANNEL_ID && messageEvent.bot_id) {
        await processWebHomeworkJob(webHomeworkJobId);
        return;
      }

      if (isHomeworkMessage(messageEvent)) {
        await enqueueHomeworkMessage({ channel: messageEvent.channel, ts: messageEvent.ts, text: messageEvent.text, user: messageEvent.user, eventId: body?.event_id, files: messageEvent.files });
        return;
      }

      if (isMangaGenerateMessage(messageEvent)) {
        await handleMangaGenerateMessage(messageEvent);
        return;
      }

      logSlideGenerateEventDecision(messageEvent);

      if (!isSlideGenerateMessage(messageEvent)) {
        return;
      }

      const requestId = getSlideRequestId(messageEvent);
      if (hasProcessedSlideRequest(requestId)) {
        return;
      }
      rememberSlideRequest(requestId);

      const slideArgs = parseSlideArgs(stripSlideGeneratePrefix(messageEvent.text ?? ""));
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

function describeSlackMessageEvent(event: SlackMessageEvent | undefined): string {
  if (!event) {
    return "event=none";
  }

  return [
    `type=${event.type ?? "unknown"}`,
    `channel=${event.channel ?? "unknown"}`,
    `ts=${event.ts ?? "unknown"}`,
    `subtype=${event.subtype ?? "none"}`,
    `text=${JSON.stringify(previewText(event.text))}`
  ].join(" ");
}

function previewText(text: string | undefined): string {
  const trimmed = text?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}...` : trimmed;
}

function getErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }

  return "unknown";
}

async function handleMangaGenerateMessage(event: SlackMessageEvent): Promise<void> {
  const requestId = getMangaRequestId(event);
  if (hasProcessedMangaRequest(requestId)) {
    return;
  }
  rememberMangaRequest(requestId);

  const mangaArgs = parseMangaSlackArgs(stripMangaGeneratePrefix(event.text ?? ""));
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

function isMangaGenerateMessage(event: SlackMessageEvent): boolean {
  if (event.type !== "message") {
    return false;
  }

  const text = event.text?.trim();
  if (!text?.startsWith(MANGA_GENERATE_PREFIX)) {
    return false;
  }

  if (!event.channel || !isAllowedSlideGenerateChannel(event.channel)) {
    return false;
  }

  if (event.subtype && event.subtype !== "bot_message") {
    return false;
  }

  return true;
}

function stripMangaGeneratePrefix(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith(MANGA_GENERATE_PREFIX)
    ? trimmed.slice(MANGA_GENERATE_PREFIX.length).trim()
    : trimmed;
}

function getMangaRequestId(event: SlackMessageEvent) {
  return event.client_msg_id ?? `${event.channel ?? "unknown"}:${event.ts ?? "unknown"}`;
}

function hasProcessedMangaRequest(requestId: string) {
  return processedMangaRequestIds.has(requestId);
}

function rememberMangaRequest(requestId: string) {
  processedMangaRequestIds.add(requestId);

  if (processedMangaRequestIds.size <= MAX_PROCESSED_REQUEST_IDS) {
    return;
  }

  const oldest = processedMangaRequestIds.values().next().value as string | undefined;
  if (oldest) {
    processedMangaRequestIds.delete(oldest);
  }
}

function isSlideGenerateMessage(event: SlackMessageEvent | undefined): event is SlackMessageEvent {
  if (!event || event.type !== "message") {
    return false;
  }

  const text = event.text?.trim();
  if (!text?.startsWith(SLIDE_GENERATE_PREFIX)) {
    return false;
  }

  if (!event.channel || !isAllowedSlideGenerateChannel(event.channel)) {
    return false;
  }

  if (event.subtype && event.subtype !== "bot_message") {
    return false;
  }

  return true;
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

  if (!isAllowedSlideGenerateChannel(event.channel)) {
    console.log(
      `[slide-generate] ignored: channel mismatch received=${event.channel} expected=${config.SLACK_COMPLETION_CHANNEL_ID ?? "unset"}`
    );
    return;
  }

  if (event.subtype && event.subtype !== "bot_message") {
    console.log(`[slide-generate] ignored: unsupported subtype=${event.subtype}`);
    return;
  }

  const args = parseSlideArgs(stripSlideGeneratePrefix(text));
  if (!args.ok) {
    console.log(`[slide-generate] accepted with parse error: ${args.errorMessage} text=${JSON.stringify(preview)}`);
    return;
  }

  console.log(
    `[slide-generate] accepted: channel=${event.channel} subtype=${event.subtype ?? "none"} user=${event.user ?? "unknown"} bot=${event.bot_id ?? "none"}`
  );
}

function stripSlideGeneratePrefix(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith(SLIDE_GENERATE_PREFIX)
    ? trimmed.slice(SLIDE_GENERATE_PREFIX.length).trim()
    : trimmed;
}

function isAllowedSlideGenerateChannel(channelId: string) {
  if (isSampleChannelId(config.SLACK_COMPLETION_CHANNEL_ID)) {
    return true;
  }

  return config.SLACK_COMPLETION_CHANNEL_ID === channelId;
}

function getSlideRequestId(event: SlackMessageEvent) {
  return event.client_msg_id ?? `${event.channel ?? "unknown"}:${event.ts ?? "unknown"}`;
}

function hasProcessedSlideRequest(requestId: string) {
  return processedSlideRequestIds.has(requestId);
}

function rememberSlideRequest(requestId: string) {
  processedSlideRequestIds.add(requestId);

  if (processedSlideRequestIds.size <= MAX_PROCESSED_REQUEST_IDS) {
    return;
  }

  const oldest = processedSlideRequestIds.values().next().value as string | undefined;
  if (oldest) {
    processedSlideRequestIds.delete(oldest);
  }
}

function isSampleChannelId(id: string | undefined): boolean {
  if (!id) {
    return true;
  }

  return /^C0{4,}/i.test(id);
}
