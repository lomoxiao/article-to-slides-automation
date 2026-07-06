# Homework Slack / Google Drive / Firebase setup

## Slack

1. Bot scopeに `files:read` と `chat:write`、対象チャンネル履歴の読取権限を追加する。
2. Botを `SLACK_HOMEWORK_CHANNEL_ID` のチャンネルへ参加させる。
3. iPhoneから本文 `[homework]` と画像1枚を同じメッセージで投稿する。
4. 複数画像、別メッセージの画像、非画像ファイルは受け付けない。

イベント内の `channel + ts + file.id` から安定したジョブIDを生成する。Slack再送時もFirebaseに同じジョブが存在すれば再処理しない。

## Google Drive / Firebase Admin

既存の `FIREBASE_DATABASE_URL` とサービスアカウントに加え、以下を設定する。

```env
SLACK_HOMEWORK_CHANNEL_ID=C000000000
HOMEWORK_REVIEW_BASE_URL=https://<user>.github.io/<repo>/homework-manga/
HOMEWORK_OWNER_UID=<Firebase Authentication UID>
HOMEWORK_DRIVE_FOLDER_ID=<宿題画像専用のGoogle DriveフォルダID>
```

FirebaseサービスアカウントはRealtime Databaseだけに使用する。元画像は既存Google OAuthユーザーのDriveへ保存し、解析結果、DriveファイルID、Slack識別情報は `/homeworkJobs/{jobId}` に保存する。Firebase Storageは使用しない。

宿題画像専用フォルダをDriveで作成し、URLの `/folders/<ID>` にあるIDを `HOMEWORK_DRIVE_FOLDER_ID` に指定する。Botは既存のGoogle OAuthと `drive.file` スコープを再利用する。画像は「リンクを知っている全員・閲覧者」に設定するが、検索対象にはしない。

確認画面の削除ボタンはジョブを `delete_requested` にする。Botが起動中ならDrive画像を削除してからDatabaseジョブを削除する。Bot停止中の要求と処理途中の `deleting` は次回起動時に再開する。自動保持期限はない。

## iPhone images

JPEG、PNG、WebPはそのまま処理する。HEIC/HEIFはRunnerでJPEGへ正規化してからGoogle DriveとCodexへ渡す。最大サイズは10MB。
