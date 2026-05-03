import { SocketModeClient } from "@slack/socket-mode";
import { config } from "../config.js";
import { notifySlackJobFailed, postSlackText } from "../services/slackNotifier.js";
import { processSlideJob } from "../services/slideJobProcessor.js";
import { runUrlToGasSlidesWorkflow } from "../workflows/urlToGasSlides.js";
import { extractFirstUrl } from "../utils/url.js";

const SLIDE_GENERATE_PREFIX = "[slide-generate]";
const MAX_PROCESSED_REQUEST_IDS = 500;
const processedSlideRequestIds = new Set<string>();

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
};

type EventsApiEnvelope = {
  event?: SlackMessageEvent;
  body?: {
    event?: SlackMessageEvent;
  };
  ack: () => Promise<void>;
};

type EnqueueSlideGenerationInput = {
  url: string;
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

    const url = extractFirstUrl(body?.text ?? "");

    if (!url) {
      await ack({
        response_type: "ephemeral",
        text: "URLを見つけられませんでした。`/slides https://example.com/article` の形式で送ってください。"
      });
      return;
    }

    let jobId: string | undefined;

    try {
      jobId = await enqueueSlideGeneration({
        url,
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
    await ack();
    const messageEvent = event ?? body?.event;
    logSlideGenerateEventDecision(messageEvent);

    if (!isSlideGenerateMessage(messageEvent)) {
      return;
    }

    const requestId = getSlideRequestId(messageEvent);
    if (hasProcessedSlideRequest(requestId)) {
      return;
    }
    rememberSlideRequest(requestId);

    const url = extractFirstUrl(messageEvent.text ?? "");
    if (!url) {
      return;
    }

    try {
      const jobId = await enqueueSlideGeneration({
        url,
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

  if (!extractFirstUrl(text)) {
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

  if (!extractFirstUrl(text)) {
    console.log(`[slide-generate] ignored: URL not found text=${JSON.stringify(preview)}`);
    return;
  }

  console.log(
    `[slide-generate] accepted: channel=${event.channel} subtype=${event.subtype ?? "none"} user=${event.user ?? "unknown"} bot=${event.bot_id ?? "none"}`
  );
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
