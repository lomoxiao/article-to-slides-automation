# Architecture

## Inbound

Slack can call the service through either:

- Slash command: `/slides https://example.com/article`
- Event subscription: message posted in a monitored channel

`src/routes/slack.ts` is intentionally thin. It validates the incoming payload, acknowledges Slack quickly, and hands off work to `urlToSlides`.

## Workflow

`src/workflows/urlToSlides.ts` coordinates the main process:

1. Fetch URL content.
2. Generate a slide outline.
3. Create a Google Slides deck.
4. Notify Slack with the generated deck URL.

## External Services

Each integration has its own service module:

- `contentFetcher`: Web article and paper extraction.
- `summarizer`: LLM prompt and structured slide outline generation.
- `googleSlides`: Google Slides / Drive creation.
- `slackNotifier`: Slack completion and error notifications.

This keeps the orchestration code readable and makes it easy to replace individual providers later.

## Production Notes

- Add Slack request signature verification before exposing publicly.
- Queue long-running jobs with Cloud Tasks, SQS, BullMQ, or similar.
- Store job state so Slack can show progress and retries are idempotent.
- Prefer service accounts or workload identity for Google API access.
- For papers, add DOI/arXiv/PDF-specific extractors before falling back to generic HTML extraction.

