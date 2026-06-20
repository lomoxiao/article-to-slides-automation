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

export async function notifyMangaCompleted(input: {
  channelId?: string;
  requestedBy?: string;
  jobId: string;
  title?: string;
  driveStep1Url?: string;
  driveStep2Url?: string;
  driveError?: string;
  notebookLmStatus?: "executed" | "skipped" | "failed";
  notebookLmDetail?: string;
}) {
  const titleLine = input.title ? `: ${input.title}` : "";
  const lines = [`${mention(input.requestedBy)}漫画ネーム生成が完了しました${titleLine}`, `Job ID: ${input.jobId}`];

  if (input.driveError) {
    lines.push(`Drive 登録は失敗しました（生成物はローカルに保存済み）: ${input.driveError}`);
  } else if (input.driveStep1Url || input.driveStep2Url) {
    if (input.driveStep1Url) lines.push(`step1: ${input.driveStep1Url}`);
    if (input.driveStep2Url) lines.push(`step2: ${input.driveStep2Url}`);
  }

  // NotebookLM 自動操作(Phase3)の結果。未実行(undefined)なら従来どおり手動手順を案内。
  switch (input.notebookLmStatus) {
    case "executed":
      lines.push("NotebookLM: ソースを同期し Step3（漫画生成）を実行しました。");
      break;
    case "skipped":
      lines.push("NotebookLM: Drive アップロード未完了のため Step3 はスキップしました。");
      break;
    case "failed":
      lines.push(
        `NotebookLM 連携に失敗しました（手動で NotebookLM を確認してください）: ${input.notebookLmDetail ?? "原因不明"}`
      );
      break;
    default:
      lines.push("次の手順: upload/ を NotebookLM に投入して Step3（スライドブック生成）を実行してください。");
  }

  await postSlackMessage({ channelId: input.channelId, text: lines.join("\n") });
}

export async function notifyMangaFailed(input: {
  channelId?: string;
  requestedBy?: string;
  jobId?: string;
  error: string;
}) {
  const jobLine = input.jobId ? `\nJob ID: ${input.jobId}` : "";
  await postSlackMessage({
    channelId: input.channelId,
    text: `${mention(input.requestedBy)}漫画ネーム生成に失敗しました。${jobLine}\n${input.error}`
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
