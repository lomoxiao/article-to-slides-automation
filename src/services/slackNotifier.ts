import { WebClient } from "@slack/web-api";
import { config } from "../config.js";

type SlackNotificationInput = {
  channelId?: string;
  requestedBy?: string;
  title: string;
  deckUrl: string;
};

export async function notifySlack(input: SlackNotificationInput) {
  await postSlackMessage({
    channelId: input.channelId,
    text: `${mention(input.requestedBy)}スライド生成が完了しました: ${input.title}\n${input.deckUrl}`
  });
}

export async function notifySlackJobAccepted(input: {
  channelId?: string;
  requestedBy?: string;
  jobId: string;
  url: string;
}) {
  await postSlackMessage({
    channelId: input.channelId,
    text: `${mention(input.requestedBy)}スライド生成ジョブを受け付けました。\nJob ID: ${input.jobId}\nURL: ${input.url}`
  });
}

export async function notifySlackGasSlidesCompleted(input: {
  channelId?: string;
  requestedBy?: string;
  jobId: string;
  deckUrl: string;
  presentationId?: string | null;
}) {
  if (isSampleChannelId(config.SLACK_COMPLETION_CHANNEL_ID)) {
    console.warn("SLACK_COMPLETION_CHANNEL_ID is not configured; skipping completion notification.");
    return;
  }

  const presentationLine = input.presentationId ? `\nPresentation ID: ${input.presentationId}` : "";
  await postSlackMessage({
    channelId: input.channelId,
    text: `${mention(input.requestedBy)}スライド生成が完了しました。\nJob ID: ${input.jobId}\n${input.deckUrl}${presentationLine}`
  });
}

export async function notifySlackJobFailed(input: {
  channelId?: string;
  requestedBy?: string;
  jobId?: string;
  error: string;
}) {
  const jobLine = input.jobId ? `\nJob ID: ${input.jobId}` : "";
  await postSlackMessage({
    channelId: input.channelId,
    text: `${mention(input.requestedBy)}スライド生成に失敗しました。${jobLine}\n${input.error}`
  });
}

export async function postSlackText(input: { channelId?: string; text: string }) {
  await postSlackMessage(input);
}

async function postSlackMessage(input: { channelId?: string; text: string }) {
  if (!config.SLACK_BOT_TOKEN) {
    return;
  }

  const channels = [config.SLACK_COMPLETION_CHANNEL_ID, input.channelId].filter(
    (channel, index, all): channel is string => Boolean(channel) && all.indexOf(channel) === index
  );

  if (channels.length === 0) {
    return;
  }

  const client = new WebClient(config.SLACK_BOT_TOKEN);

  for (const channel of channels) {
    try {
      await client.chat.postMessage({
        channel,
        text: input.text,
        unfurl_links: false
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to post Slack message to ${channel}: ${message}`);
    }
  }
}

function mention(userId?: string) {
  return userId ? `<@${userId}> ` : "";
}

function isSampleChannelId(id: string | undefined): boolean {
  if (!id) {
    return true;
  }

  return /^C0{4,}/i.test(id);
}
