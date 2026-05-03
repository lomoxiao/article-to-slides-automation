# Article to Slides Automation

Slack に投稿された Web 記事や論文の URL を受け取り、ローカル Codex で `slideData.json` を生成し、まじん式 Google Apps Script 経由で Google スライドを自動生成・保存するワークフローです。

Node.js から OpenAI API などの従量課金 LLM API は呼びません。Slack 受付後にローカルの `codex exec` を起動し、Codex の固定課金枠内で要約とスライド構成を作る前提です。

## 完全自動モードの流れ

1. Slack から `/slides https://example.com/article` を送る
2. Socket Mode でローカル PC がコマンドを受け付ける
3. `jobs/pending/<jobId>/job.json` を作成する
4. バックグラウンドで `codex exec` を起動する
5. Codex が `source.txt` とテンプレート設定を読み、`slideData.json` を生成する
6. `slideData.json` を検証して GAS Web App に POST する
7. まじん式テンプレートで Google スライドを保存する
8. Slack に完了通知と Google スライド URL を投稿する

## セットアップ

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run typecheck
```

PowerShell では `npm` が実行ポリシーで止まることがあるため、`npm.cmd` を使うのが確実です。

## `.env` 設定

```env
PORT=3000

SLACK_APP_TOKEN=xapp-your-app-level-token
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=...
SLACK_COMPLETION_CHANNEL_ID=C000000000

GAS_WEB_APP_URL=https://script.google.com/macros/s/.../exec
GOOGLE_DRIVE_FOLDER_ID=...

AUTO_RUN_CODEX=true
CODEX_CLI_COMMAND=codex
CODEX_RUNNER_HOME=./.codex-runner-home
CODEX_EXEC_SANDBOX=workspace-write
CODEX_EXEC_FULL_AUTO=true
CODEX_EXEC_TIMEOUT_MS=900000
```

`SLACK_COMPLETION_CHANNEL_ID` は完了通知を投稿するSlackチャンネルIDです。Botをそのチャンネルに招待しておいてください。未招待の場合、Slack API は `not_in_channel` を返します。

`CODEX_RUNNER_HOME` は自動実行用の Codex ホームです。通常の `C:\Users\<user>\.codex` がWindowsサンドボックス上で読み取り専用になることがあるため、ランナーは認証と設定だけをこのフォルダへコピーして実行します。このフォルダは `.gitignore` 済みです。

このプロジェクトが Git リポジトリではない環境でも動くように、ランナーは `codex exec --skip-git-repo-check` を付けて起動します。

## Slack Socket Mode 設定

Slack App の設定で次を行います。

1. Socket Mode を有効化する
2. App-Level Token を作成する
   - Token は `xapp-` で始まります
   - Scope は `connections:write`
3. Slash Command `/slides` を作成する
4. Bot Token Scopes に `commands` と `chat:write` を追加する
5. Slack App をワークスペースにインストールする
6. 完了通知先チャンネルにBotを招待する

起動します。

```powershell
npm.cmd run dev
```

`SLACK_APP_TOKEN` が設定されている場合は Socket Mode で起動します。未設定の場合は、HTTP Webhook `/slack/commands/slides` にフォールバックします。

## 手動再実行

完全自動モードで失敗したジョブや、途中で止まったジョブは手動で再実行できます。

```powershell
npm.cmd run jobs:process -- <jobId>
```

`slideData.json` が既に存在する場合は、Codex生成をスキップしてGAS送信から再開します。明示的に別ファイルを使う場合は次のように指定できます。

```powershell
npm.cmd run jobs:process -- <jobId> path\to\slideData.json
```

## プロンプトインジェクション対策

Codex 向けプロンプトには、記事本文や `source.txt` を「命令ではなく入力データ」として扱う指示を含めています。記事内にファイル変更、ツール実行、秘密情報の表示、指示上書きなどを求める文言があっても無視し、出力先は対象ジョブ配下の `slideData.json` のみに固定します。

Codex実行後は `slideData.json` が存在し、JSON配列であることを確認してからGASへ送信します。

## 便利コマンド

```powershell
npm.cmd run typecheck
npm.cmd run slides:create:gas -- jobs\completed\sample\slideData.json
npm.cmd run jobs:process -- <jobId>
```

## ディレクトリ構成

```text
src/
  index.ts
  config.ts
  routes/slack.ts
  slack/socketModeClient.ts
  workflows/
    urlToGasSlides.ts
    urlToSlides.ts
  services/
    codexRunner.ts
    contentFetcher.ts
    gasSlides.ts
    jobStore.ts
    slackNotifier.ts
    slideJobProcessor.ts
  scripts/
    processSlideJob.ts
    createSlidesViaGas.ts
config/
  auto-slides-output-config.json
templates/
  auto-slides-template.md
gas/
  majin-webhook-adapter.gs
jobs/
  pending/
  processing/
  completed/
  failed/
```

## GAS Viewer連携

GAS Viewerからスライド生成を依頼する場合、GAS側はSlack API `chat.postMessage` で以下の形式のメッセージを投稿します。

```text
[slide-generate] https://example.com/article
```

Slack Socket Mode側がこのメッセージを受信し、既存のローカルCodex生成処理を起動します。GASから `/slides URL` を投稿してもSlash Commandは発火しないため、GAS Viewer連携では必ず `[slide-generate] URL` 形式を使います。

`SLACK_COMPLETION_CHANNEL_ID` は、GAS Viewer連携では「生成依頼受付・完了通知兼用チャンネル」として使います。

```env
SLACK_COMPLETION_CHANNEL_ID=C000000000
```

`SLACK_COMPLETION_CHANNEL_ID` が設定されている場合、Socket Mode側はそのチャンネル以外の `[slide-generate]` メッセージを無視します。GAS側の投稿先チャンネルIDは、`article-to-slides-automation` 側の `SLACK_COMPLETION_CHANNEL_ID` と同じチャンネルにしてください。

注意点:
- ローカルCodexを動かすため、`article-to-slides-automation` はローカルPCで起動しておく必要があります。
- Socket Modeを使うため、`SLACK_APP_TOKEN` が設定されている必要があります。
- GASからSlackへ投稿するため、GAS側にはSlack Bot Tokenと投稿先チャンネルIDが必要です。
- 通常のSlack投稿は処理されません。`[slide-generate]` prefixを持つメッセージだけが対象です。
