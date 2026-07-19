# Google Slides 自動保存の設定

Google Slides への自動保存には、Google Cloud の service account と保存先 Google Drive フォルダ ID が必要です。

## 1. Google Cloud で API を有効化する

Google Cloud Console で対象プロジェクトを開き、次の API を有効化します。

- Google Slides API
- Google Drive API

## 2. Service account を作成する

Google Cloud Console で service account を作成し、JSON キーを発行します。

発行した JSON ファイルは、リポジトリの外の `~/.content-extractor/` に
`google-service-account.json` という名前で置きます（他の Google/Firebase 資格情報と同じ場所）。

```text
C:\Users\<you>\.content-extractor\
  google-service-account.json
```

秘密情報はリポジトリ内に置きません（gitignore 済みでも平文秘密をリポジトリ配下に残さない方針）。

## 3. 保存先 Google Drive フォルダを共有する

Google Drive でスライドの保存先フォルダを作成し、そのフォルダを service account のメールアドレスに共有します。

service account のメールアドレスは JSON ファイル内の `client_email` に書かれています。

権限は、まずは編集者にしてください。

## 4. フォルダ ID を取得する

保存先フォルダをブラウザで開くと、URL は次のような形になります。

```text
https://drive.google.com/drive/folders/XXXXXXXXXXXXXXXXXXXXXXXX
```

この `XXXXXXXXXXXXXXXXXXXXXXXX` の部分が `GOOGLE_DRIVE_FOLDER_ID` です。

## 5. `.env` を設定する

`.env` を次のように設定します。

```env
GOOGLE_APPLICATION_CREDENTIALS=C:\Users\<you>\.content-extractor\google-service-account.json
GOOGLE_DRIVE_FOLDER_ID=XXXXXXXXXXXXXXXXXXXXXXXX
SUMMARY_PROVIDER=codex_job
```

Slack 通知まで試す場合は、Slack 関連の値も設定します（入口は Socket Mode のみ）。

```env
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_COMPLETION_CHANNEL_ID=C0123456789
```

## 6. 動作確認

依存関係をインストールします。

```bash
npm install
```

型チェックを実行します。

```bash
npm run typecheck
```

生成済みアウトラインから Google Slides を作成します。

```bash
npm run slides:create -- jobs/completed/2026-04-29-quantum-ai/outline.json
```

成功すると、Google Slides の URL が表示されます。
