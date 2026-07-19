# Google ユーザー OAuth 設定

個人の Google Drive にスライドを保存する場合は、service account ではなくユーザー OAuth を使います。

## 1. OAuth クライアントを作成する

Google Cloud Console で OAuth クライアント ID を作成します。

- アプリケーションの種類: デスクトップ アプリ
- 有効化する API: Google Slides API, Google Drive API

作成後、JSON をダウンロードして、リポジトリの外の `~/.content-extractor/` に置きます。

```text
C:\Users\<you>\.content-extractor\
  google-oauth-credentials.json
```

## 2. `.env` を設定する

`GOOGLE_OAUTH_CREDENTIALS` / `GOOGLE_OAUTH_TOKEN` は未設定のままにします
（既定で `~/.content-extractor/` の同名ファイルを使い、トークンも同じ場所に保存されます）。

```env
GOOGLE_AUTH_MODE=oauth
GOOGLE_DRIVE_FOLDER_ID=保存先フォルダID
SUMMARY_PROVIDER=codex_job
```

## 3. 初回認可を実行する

対話入力できる環境では、次のコマンドを使います。

```powershell
npm.cmd run google:oauth
```

表示された URL をブラウザで開き、Google アカウントで許可します。

表示された認可コードをターミナルに貼り付けると、`~/.content-extractor/google-oauth-token.json` が保存されます。

対話入力しづらい環境では、認可 URL の表示とコード保存を分けます。

```powershell
npm.cmd run google:oauth:url
```

表示された URL をブラウザで開いて認可し、取得したコードを次のコマンドに渡します。

```powershell
npm.cmd run google:oauth:code -- 認可コード
```

## 4. スライドを作成する

```powershell
npm.cmd run slides:create -- jobs/completed/2026-04-29-quantum-ai/outline.json
```

成功すると Google Slides の URL が表示されます。
