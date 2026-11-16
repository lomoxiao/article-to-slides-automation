# Architecture

更新: 2026-11-16（取り込み工程の独立と依頼入口の一本化を反映）

## 全体の流れ

```
入口                      依頼の受付                取り込み                 生成                 閲覧
Viewer (URL / テキスト) ─▶ /generationRequests ─┐
Slack (/slides ほか) ─────────────────────────┼─▶ ingestArticle ─▶ /articleSources ─▶ スライド / 漫画 / 動画 ─▶ Viewer
news-dashboard (材料) ───▶ 1日のまとめ ────────┘        (本文を1回だけ取得し、判定つきで保存)
```

## 入口

- **Viewer**: Firebase Realtime Database の `/generationRequests` に依頼を書く。
  `src/requests/generationRequestWatcher.ts` が受け取る。`kind` は `text`（本文を直接投入）と `url`。
- **Slack**: Socket Mode のみ（`src/slack/socketModeClient.ts`、`SLACK_APP_TOKEN` が必要）。
  外向きの WebSocket 接続なので、公開 HTTP エンドポイントは持たない。
- **1日のまとめ**: news-dashboard が書き出す材料ファイルを `src/domains/digest/` が拾う（`DIGEST_ENABLED`）。
- **iPhone ショートカット**: GitHub Actions（`register-article.yml`）経由で記事の URL を登録するだけ（生成はしない）。

## 取り込み

`src/domains/ingest/ingestArticle.ts` が、URL の本文取得をすべて担当する。

1. URL を掃除し、内部ネットワーク宛てでないことを確かめる。
2. 保存済みの本文が再利用期間内（`INGEST_REUSE_HOURS`）で「全文」なら、それを返す。
3. それ以外は `@local/content-extractor` で取得する。品質判定（全文 / 一部 / 失敗）が必ず付く。
4. 失敗なら `SourceUnavailableError`。生成側はこれを「対応待ち（action_required）」として Viewer に出す。
5. 取れた本文は判定つきで `/articleSources/{articleId}` に保存し、記事に取り込み状態（`ingest`）を書く。

## 生成

機能ごとに `src/domains/` に分かれる。

- `slides/`: Codex で `slideData.json` を作り、GAS 経由で Google スライドにする。3 行要約（TLDR）もここで作る。
- `manga/` と `notebooklm/`: 漫画の構成を作り、NotebookLM を操作してデックを得る。
- `video/`: 60 秒の解説動画（Kokoro TTS + HyperFrames）。feature flag で有効化。
- `reader/`: Kobo 向けの読書用エディションと Instapaper 送信。
- `digest/`: 1 日のまとめ（3 行要約・本文・音声）。

## 束（複数記事のまとめ）

`src/domains/bundle/`。依頼キューの `kind: "bundle"`（記事ID 2〜10件）から始まる。

| ファイル | 役割 |
|---|---|
| `articleDigest.ts` | 記事ごとの要点抽出。`/articleDigests/{記事ID}` に保存し、本文が変わらなければ再利用する |
| `bundleSynthesis.ts` | 統合のプロンプト、出力の検証、本文の組み立て（AI を使わない） |
| `bundlePipeline.ts` | 全体の流れ。本文の用意は部分成功（取れない記事は理由を記録して続ける）。全記事が出典に現れなければ1回だけ再実行し、それでも欠けた記事は「その他の記事」として機械的に足す |

束は `bundle:bnd_<メンバーIDを並べ替えたもののハッシュ>` という疑似URLで通常の記事と同じ仕組みに載る（テキスト投入の `text:txt_…` と同じ考え方）。
メンバーの一覧は `/articles/{束ID}/bundle/members` に書く。

## 同時実行の制御

- `codex exec` と `claude` の実行は、それぞれ同時に 1 本（`shared/resourceSemaphore.ts`）。
- 漫画・動画・音声合成などの重い処理も同時に 1 本（`resourceIntensiveSemaphore`）。
- 取得順は「重い処理用 → AI 実行用」。逆順では取らない。

## 再起動時の扱い

中断された処理は自動では再実行せず、状態を直すだけにする。

- 依頼キュー: `processing` の依頼を `failed` に落とす。
- スライド: `jobs/processing` の残りを `failed` に移す（`slides/slideJobRecovery.ts`）。
- 動画: 中断ジョブを `action_required` にする。
- 1 日のまとめ: 当日分が未作成なら作る。

## データ（Firebase Realtime Database）

| パス | 内容 | 書き込み |
|---|---|---|
| `/articles/{articleId}` | 記事と成果物（slides / manga / video / audio）の状態、3 行要約、取り込み状態 | 管理側。閲覧者は成果物 URL の手動登録と削除の印のみ |
| `/articleSources/{articleId}` | 保存済み本文と品質判定 | 管理側のみ |
| `/articleAudio/{articleId}` | 音声データ（base64） | 管理側のみ |
| `/generationRequests/{id}` | Viewer からの生成依頼 | 閲覧者が新規作成、管理側が更新 |
| `/artifactDiagnostics/...` | 技術的なエラーの詳細 | 管理側のみ |

アクセスルールの正本は `multimodal-article-viewer/database.rules.json`。
