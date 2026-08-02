# 動画生成 本番反映前チェック（schema v2）

対象は記事から55〜65秒、1920x1080、H.264/AACの解説動画をローカル生成する経路である。`VIDEO_GENERATION_ENABLED=false`のまま確認し、Drive/Firebaseへのアップロードは実アカウントE2E時だけ行う。

## 実装済み

- VideoPlan schema v2と7種の`VisualSpec`
- 見出し、補足文章、右側の固定図解カード
- 意味単位`captionPhrases`の個別TTSと実測時間による字幕同期
- 短すぎる字幕の隣接結合、長すぎる字幕の安全停止
- `captions.json`、manifest v2、project ZIPへの字幕情報保存
- sourceだけを再利用し、plan/TTS/caption/renderの旧チェックポイントを無効化する工程バージョン
- production経路と標準セットアップから音声認識モデル依存を除去
- Viewerの`video_captioning`表示と既存slides/manga/video表示の回帰テスト

## 自動確認

```powershell
npm run typecheck
npm run build
npm test
npm run video:preflight:smoke
npm run video:template:smoke
```

テンプレートスモークの合格条件は次のとおり。

- 55〜65秒
- 1920x1080、H.264、AAC、音声ストリームあり
- 500MB未満
- HyperFrames `lint`、`check --strict`、`snapshot`、`render`成功
- すべての字幕が1.5〜6秒、最大2行、実測時間の累積と一致

Viewerでは独立して次を実行する。

```powershell
npm run check
npm test
```

## 本番有効化前に残る確認

代表3記事のアップロードなし生成と機械検査は完了した。

| jobId | 尺 | 字幕数 | 字幕範囲 | サイズ |
|---|---:|---:|---:|---:|
| `20260802T060130Z-7f1d351b` | 63.63秒 | 20 | 2.000〜4.300秒 | 5,727,503 bytes |
| `20260802T063502Z-49c3f73b` | 60.30秒 | 21 | 2.175〜3.900秒 | 5,614,753 bytes |
| `20260802T064316Z-7755e6d7` | 60.10秒 | 21 | 1.575〜3.975秒 | 5,590,573 bytes |

全件でschema v2、1920x1080、H.264/AAC、音声あり、HyperFrames lint／strict check／snapshot／render成功を確認した。

残る確認は次のとおり。

1. 字幕が意味単位で自然に読め、フレーズ境界で音声が不自然に途切れないことを人手確認する。
2. 見出し、補足文章、各図解カードに重なりや情報欠落がないことを人手確認する。
3. Drive/Firebase実アカウントE2Eで外部リンクとViewer表示を確認する。
4. 合格後に限り本番の`VIDEO_GENERATION_ENABLED`を有効化する。

## 運用上の注意

- ジョブ中にブラウザやモデルを自動ダウンロードしない。
- 旧音声認識モデルのキャッシュは自動削除しない。不要と判断した管理者が別途削除する。
- 外部画像、画像生成API、新規従量課金サービスは使用しない。
- DriveとViewerのMP4契約はschema v1から変更しない。
