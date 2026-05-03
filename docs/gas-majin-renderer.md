# まじん式 GAS レンダラー連携

添付の `コード.gs` は、今回生成している `slideData.json` とかなり相性がよいです。

確認できた主なポイント:

- `generateSlidesFromWebApp(slideDataString, settings, presentationId, imageUpdateOption)` がある
- `createPresentation(slideData, settings, ...)` が Google Slides を生成する
- `slideGenerators` に主要な `type` が登録されている
- 今回の `slideData.json` で使った `title`, `agenda`, `content`, `compare`, `process`, `statsCompare`, `processList`, `kpi`, `pyramid`, `faq`, `closing` は対応済み

## 注意点

元コードのライセンスコメントでは、商用利用が不可、法人利用は条件付き可とされています。

社内利用する場合は、元作者の利用条件を確認してください。

## Webhook 化

元コードは Web アプリ UI から `generateSlidesFromWebApp` を呼ぶ構成です。

Slack / Node.js から自動実行するには、同じ Apps Script プロジェクトに次のアダプタを追加します。

```text
gas/majin-webhook-adapter.gs
```

このアダプタは `doPost(e)` を追加し、POST された `slideData` を `generateSlidesFromWebApp` に渡します。

## GAS 側の手順

1. Apps Script プロジェクトに添付の `コード.gs` を配置する
2. 同じプロジェクトに `gas/majin-webhook-adapter.gs` の内容を追加する
3. Web アプリとしてデプロイする
4. 発行された `/exec` URL を `.env` の `GAS_WEB_APP_URL` に設定する

推奨デプロイ設定:

- 実行するユーザー: 自分
- アクセスできるユーザー: 全員
- URL: `/exec` で終わる Web アプリ URL

変更後は必ず新しいバージョンとして再デプロイしてください。

## Node 側の実行

```powershell
npm.cmd run slides:create:gas -- jobs/completed/2026-04-29-quantum-ai/slideData.json
```

成功すると、GAS が作成した Google Slides の URL が返ります。
