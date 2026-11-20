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
npm.cmd run playwright:setup
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

## Viewer連携（依頼キュー）

Viewer（multimodal-article-viewer）からの生成依頼は、URL投入・テキスト投入とも Firebase Realtime Database の
`/generationRequests` に書き込まれ、このサービスが受け取って処理します（`src/requests/generationRequestWatcher.ts`）。
以前の「Viewer → GAS → Slack 投稿 → このサービス」という経路は、2026-11 に廃止しました。

処理の流れ（URL投入）:

1. Viewer が `{ kind: "url", urls: [...], slides, manga, video, ... }` を `status: "queued"` で書く
2. このサービスが依頼を受け取り、記事を登録する
3. 取り込み工程（`src/domains/ingest/ingestArticle.ts`）が本文を取得して保存する
   - 取れなかった場合は、何も生成せず `failed`（`errorCode: SOURCE_UNAVAILABLE`）にし、
     Viewer に「本文が取れていません（理由）」を表示する
   - 取れた場合は、依頼に `ingest: { verdict, chars }` を書く（Viewer が「本文を取得しました」を表示）
4. スライド・漫画・動画の生成へ進む。生成側も取り込み工程を通るため、保存済みの本文が再利用される

Slack からの依頼（`/slides`、`[slide-generate]`、`[manga-generate]`、`[video-generate]`）は引き続き使えます。
Slack 経由でも、生成の中で同じ取り込み工程を通ります。

### 取り込みの設定

| 環境変数 | 既定 | 内容 |
|---|---|---|
| `INGEST_REUSE_HOURS` | `24` | 保存済み本文を再利用する期間（時間）。`0` は期限なし |
| `WEB_HTTP_USER_AGENT` | Chrome の名乗り | 記事取得時にサイトへ名乗る User-Agent |
| `WEB_HTTP_TIMEOUT_MS` | `30000` | 記事取得のタイムアウト |

強制的に取り直す場合は `npm run reader:refresh -- <URL>` を使います。

### 調査用コマンド

```powershell
npm.cmd run article:show -- <記事URL>      # 記事の状態を表示（読み取りのみ）
npm.cmd run article:restore -- <記事URL>   # Viewer で削除した記事を一覧に戻す
npm.cmd run extraction:probe -- docs/extraction-probe-urls.txt   # 取り込みの計測
```

注意点:
- ローカルCodexを動かすため、`article-to-slides-automation` はローカルPCで起動しておく必要があります。
- 依頼の受付には Firebase の認証情報（サービスアカウント）が必要です。
- Viewer で削除した記事に再び生成を依頼すると、記事は一覧に戻ります。

## 1日のまとめ

news-dashboard が毎朝書き出す材料（`.runtime/digest/YYYY-MM-DD.json`）から、「今日のまとめ」（3行要約・本文・音声）を
1日1本作ります。`DIGEST_ENABLED=true` と `DIGEST_SOURCE_DIR` の設定で、起動時と30分ごとに自動実行されます。
手動実行と失敗した日の再実行は `npm run digest:run -- [--date YYYY-MM-DD] [--force]` です。

## 簡易ブックマーク（保存だけ）

読みたい記事を、iPhone の共有メニューや PC のブックマークバーから 1 操作で保存できます。保存の時点ではスライド等を作りません。
設定の手順は [docs/bookmark-setup.md](docs/bookmark-setup.md) を参照してください。

- iPhone: ショートカット → GitHub（`register-article.yml`）→ 記事を登録。PC が止まっていても保存できます。
- PC: ブックマークバーのボタン → Viewer の小窓 → 依頼キューの `kind: "save"` → 常駐プロセスが登録。
- `INBOX_SUMMARY_ENABLED=true` にすると、保存しただけの記事に 3 行要約とタイトルを付けます
  （`INBOX_SUMMARY_INTERVAL_MIN` 分ごとに最大 `INBOX_SUMMARY_MAX_PER_TICK` 件）。

## 音声の合成方法（Kokoro / Gemini TTS）

1日のまとめ・束などの音声は、既定では PC 内の Kokoro で作ります。`.env` で `TTS_PROVIDER=gemini` と `GEMINI_API_KEY` を設定すると Gemini TTS で作ります。

- Gemini が失敗したとき、1日の上限（`GEMINI_TTS_MAX_CHARS_PER_DAY`）を超えるときは、自動で Kokoro に切り替えます。
- 動画のナレーションは、`GEMINI_TTS_SCOPE=all` にしない限り Kokoro のままです。
- どちらで作ったかは `/articles/{記事ID}/audio/provider` に残ります。
- API の形と確認日は [docs/gemini-tts-notes.md](docs/gemini-tts-notes.md)。Gemini API は従量課金になり得ます。

## 深掘りリサーチ

Viewer の記事の詳細や受信箱から「深掘り」を開き、観点（関連する記事・世間の評価・反対意見・技術的な裏付け・その後の動き・自分の仕事への影響）を選んで依頼すると、出典つきのレポートが「深掘り」タブに届きます。方式は brain Vault の ADR `2026-11-21-catchup-research-method`。

1. 元記事の要約と要点を用意する（束と同じ `/articleDigests` を再利用）
2. 調べる：Codex を **書き込み不可（read-only）・Web 検索は cached** で実行し、観点ごとに「事実＋出典 URL」を挙げさせる
3. 確かめる：プログラムが出典 URL を取得する（AI なし）。**取得できなかった出典に基づく記述は使わない**
4. まとめる：Codex を Web なしで実行し、取得できた本文だけを材料にレポートを書く
5. 深掘りレポートを `research:rsc_…` として登録する（同じ元記事・観点・補足なら上書き）。音声は任意

- 同時に 1 件、1 日 `RESEARCH_MAX_PER_DAY` 件まで、1 件 `RESEARCH_TIMEOUT_MIN` 分まで。確認できる出典が 2 件未満なら作らず、理由を返します。
- 事前確認の手順と結果は `docs/research-spike.md` と `docs/research-spike-results.md`（`npm run research:spike`）。

## 束（複数記事のまとめ）

Viewer の一覧で「束ねる」を押して記事を2〜10本選ぶと、依頼キューに `kind: "bundle"` の依頼が入り、常駐プロセスが束を作ります。

1. 記事ごとに要点を取り出す（`/articleDigests/{記事ID}` に保存。同じ記事を別の束に入れても AI 実行は繰り返さない）
2. 要点を統合して、3行要約・本文・読み上げ原稿を作る（Codex 1回）
3. 束を「合成された記事」（`bundle:bnd_…`）として登録する。同じ組み合わせなら同じ束に上書きする

- 本文が取れない記事があっても、取れた記事で束を作り、含められなかった記事を理由つきで明示します。含められる記事が2本未満なら作りません。
- 既定の出力は Viewer 内で読める3行要約・本文・音声です。スライド・漫画・動画は依頼で選んだときだけ追加で作ります。
- 上限は `BUNDLE_MAX_MEMBERS`（既定 10）。

## Viewer成果物ステータス

Firebaseの`slides`と`manga`は共通の`pending | processing | action_required | failed | completed`を使用します。`stage`で現在または失敗した工程を表し、一般viewer向けの説明は`statusMessage`へ保存します。

漫画はDrive登録、NotebookLMソース登録、デック生成、URL取得を個別に記録します。デック生成またはURL取得で自動処理を継続できない場合は、手動操作で復旧できる`action_required`になります。技術的なエラーは記事データへ混在させず、editor専用の`/artifactDiagnostics/{articleId}/{artifactType}`へ保存します。

## 60秒解説動画（段階導入）

記事から55〜65秒・1080pのMP4をローカル生成し、Google Driveへ保存する機能はfeature flagで無効化されています。初期セットアップ、実CLI契約、未完了のPhase 0受入項目は [docs/video-spike.md](docs/video-spike.md) を参照してください。

TTSは公式Kokoro＋Misaki日本語G2P＋完全版UniDicへ一本化しています。初回は `powershell -ExecutionPolicy Bypass -File scripts/setup-video-tts.ps1`、`npm run video:browser:ensure` の順で実行してください。UTF-8日本語ラベル保持検査付きリッチ固定テンプレートの再生成は `npm run video:template:smoke`、TTSと意味単位字幕の受入スモークは `npm run video:preflight:smoke`、通常診断は `npm run video:preflight`、単体生成は `npm run video:generate -- --url <URL> [--motion basic|rich]` です。Slackの `[video-generate]` でも同じ `--motion` を使用できます。

GSAPリッチ図解は `VIDEO_RICH_MOTION_ENABLED=true` で有効化します。新規ジョブの要求値は `rich`、既存ジョブの再開は互換性のため `basic` です。リッチ図解のストーリーボード生成またはHyperFrames strict検査だけが失敗した場合は、同じ音声・字幕を使って自動的にbasic版へ退避し、理由をmanifestへ記録します。本番判定は [docs/video-production-readiness.md](docs/video-production-readiness.md) を参照し、Rulesデプロイと実アカウントE2Eが終わるまで `VIDEO_GENERATION_ENABLED=false` を維持してください。
