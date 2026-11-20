# Gemini TTS の確認メモ

確認日: 2026-11-18。実装（`src/domains/video/geminiNarration.ts`）はこのメモの形に合わせている。
仕様や料金は変わるので、使い始める前と、うまく動かなくなったときは公式ページを見直すこと。

## 公式ページ

- 音声合成の説明: https://ai.google.dev/gemini-api/docs/speech-generation
  （2026-11-18 時点では https://aistudio.google.com/docs/speech-generation?generate-content=true に転送される）
- モデル: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts 、 …/gemini-3.8-flash-lite-tts
- 料金: Gemini API の料金ページ（無料枠・有料の単価は実装時に本人が確認する）

## 使っている形（generateContent・1 話者）

- `POST https://generativelanguage.googleapis.com/v1beta/models/<モデル>:generateContent`
- ヘッダー: `x-goog-api-key: <APIキー>`、`Content-Type: application/json`
- 本文:
  ```json
  {
    "contents": [{ "role": "user", "parts": [{ "text": "<原稿>", "speech_metadata": { "style": "<話し方>" } }] }],
    "generationConfig": { "responseModalities": ["AUDIO"], "speechConfig": { "voiceConfig": { "voice": "Kore" } } }
  }
  ```
  3.8 系は入力の文をそのまま読むので、話し方の指示は本文に混ぜず `speech_metadata.style` に置く。
- 応答: `candidates[0].content.parts[0].inlineData.data` に base64 の音声。
  既定は WAV（RIFF ヘッダー付き、24kHz・モノラル・16bit）。
- 声: Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede ほか 30 種類。既定は `Kore`（`GEMINI_TTS_VOICE` で変更）。
- 日本語: 両モデルとも対応。入力の言語は自動で判別される。
- モデル: `gemini-3.8-flash-tts`（品質重視）と `gemini-3.8-flash-lite-tts`（速い・安い）。同じ形で、モデル名だけで切り替えられる。既定は Flash-Lite。
- 旧プレビュー版（`gemini-3.1-flash-tts-preview` など）は 2026-11-17 に終了予定と告知されていたため使わない。

## 長さ

公式の説明ページには入力の上限が書かれていない（モデルのページには入力 8,192 トークン・出力 16,384 トークンとある）。
出力の音声は 1 秒あたり約 25 トークンなので、1 回で作れるのは 10 分程度まで。
余裕を持たせるため、原稿を 1,200 文字ごとに段落・文の切れ目で分けて順に合成し、つないでいる。

## 安全のための作り

- API キーはヘッダーにだけ載せる。URL・ログ・エラー・Firebase には出さない（エラー文からも念のため取り除く）。
- Gemini が失敗したとき、1 日の上限（`GEMINI_TTS_MAX_CHARS_PER_DAY`）を超えるときは Kokoro で作る。
- 使った文字数は `.runtime/tts-usage.json` に JST の日付ごとに記録する（直近 14 日分）。
- どちらで作ったかは `/articles/{記事ID}/audio/provider` に残る（`gemini-tts` / `kokoro-misaki-ja`）。
