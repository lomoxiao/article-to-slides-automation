# 動画生成スパイク結果（schema v2）

## 採用構成

- HyperFramesは`0.7.87`へ固定し、映像の`lint`、`check --strict`、`snapshot`、`render`とブラウザ管理に使用する。
- 日本語音声はKokoro-82M＋Misaki日本語フロントエンド＋UniDicをローカル実行する。
- 字幕は音声認識を使わず、VideoPlanの`captionPhrases`を個別にTTSし、変換後WAVの実測時間から生成する。
- 外部画像、CDN、外部フォント、クラウドTTS、クラウドレンダリングは使用しない。

## 字幕と時間契約

各シーンは1〜3件の意味単位フレーズを持つ。空白を除いた連結結果はナレーションと完全一致しなければならない。

1. フレーズごとにraw WAVを生成し、FFprobeで尺を測る。
2. 全体尺から共通`atempo`係数を決め、全フレーズへ適用する。
3. 変換後WAVを再計測し、累積値だけから`CaptionCue`とシーン境界を確定する。
4. 1.5秒未満は同一シーンの隣接フレーズと結合して再TTSする。
5. 6秒を超える場合は`CAPTION_DURATION_INVALID`として停止する。

生成結果は`captions.json`へ保存する。字幕は最大2行で、文字単位の切替やカラオケ式ハイライトは行わない。

## 映像契約

解説シーンは左側に見出しと補足説明、右側に記事内容から生成した固定図解カードを表示する。図解種別は`title`、`keypoints`、`steps`、`compare`、`number`、`quote`、`summary`で、CSSとインラインSVGだけで描画する。

HyperFrames 0.7.87には`build`コマンドがないため、完成ゲートは次の順序とする。

```text
lint -> check --strict -> snapshot -> render
```

## セットアップと確認

標準セットアップに音声認識モデルは含めない。既存環境に残る旧モデルキャッシュは自動削除しない。

```powershell
npm run video:tts:setup
npm run video:browser:setup
npm run video:preflight:smoke
npm run video:template:smoke
```

テンプレートスモークでは14件の意味単位字幕を含む約60秒、1920x1080、H.264/AACのMP4生成を確認した。
