# 段階9 実装計画：音声を Gemini TTS に切り替えられるようにする

作成: 2026-11-17
位置づけ: キャッチアップ基盤の拡張（随時）。他の段階に依存しない。
実装担当: コーディングエージェントを想定。

## 1. 目的

1 日のまとめ・束・深掘りの読み上げを、設定 1 つで Gemini の音声合成に切り替えられるようにする。
今の音声合成（Kokoro）は残し、失敗時の控えにする。

## 2. 先に人が決めること

**これは「API の従量課金は使わない」方針の例外になる。** 実装前に次を確認する。

1. 例外として認めるか。認めない場合、この計画は実施しない。
2. 無料枠で使うか、課金を有効にするか。無料枠では、送った内容が Google の製品改善に使われることがある。
   読み上げ原稿は公開記事の要約だが、テキスト投入した私的な文章を束に入れた場合はそれも送られる。
3. API キーは本人が `.env` に入れる。エージェントは実値を読まない・表示しない・ログに出さない。

## 3. 現状（コードで確認済み）

- 音声合成の入口は `src/domains/video/narrationProvider.ts`。`NarrationProvider`
  （`synthesize({ textFile, outputPath })`）の実装は `KokoroMisakiJaNarrationProvider` の 1 つだけで、
  `getNarrationProvider()` が固定で返す。出力は WAV。
- まとめ・束の音声は `src/domains/digest/digestAudio.ts` の `synthesizeDigestAudio`。
  WAV を作り、ffmpeg で M4A（AAC・モノラル・32kbps）にして、2.5MB 以下であることを確かめる。
- 動画（60 秒解説）のナレーションも同じ入口を使う。
- 読み上げ原稿は 600〜2,000 文字。

## 4. 外部仕様（実装時に公式ドキュメントで必ず確認する。記憶や推測で書かない）

- 公式: https://ai.google.dev/gemini-api/docs/speech-generation と各モデルのページ。
- 2026-11 時点の現行モデルは `gemini-3.8-flash-tts` と `gemini-3.8-flash-lite-tts`。旧プレビュー版は使わない。
- 呼び出しは REST の `generateContent`（`https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`、
  ヘッダー `x-goog-api-key`）。3.8 系は既定で WAV を返す。入力の上限はモデルのページに記載がある。
- リクエスト本文の正確な形（音声の指定・話し方の指定の置き場所）は、3.8 系で旧版から変わっている。
  公式の例をそのまま使うこと。

## 5. 完了条件

1. `.env` の `TTS_PROVIDER=gemini` で、まとめ・束・深掘りの音声が Gemini で作られる。`kokoro`（既定）で今までどおり。
2. Gemini の呼び出しが失敗したら、自動で Kokoro に切り替えて音声を作る（ログに理由を残す）。
3. どちらで作ったかが `/articles/{id}/audio/provider` に残る。
4. 1 日あたりの上限文字数を超えたら Gemini を使わず Kokoro にする。
5. API キーがログ・エラーメッセージ・Firebase・テストの出力に出ない。
6. 動画のナレーションは既定では Kokoro のまま（設定で広げられる）。
7. `typecheck`・`lint`・`test` が通る。新しい npm 依存は追加しない（Node の `fetch` を使う）。

## 6. 設計

- 設定（`config.ts`・`.env.example`）:
  `TTS_PROVIDER`（`kokoro` | `gemini`、既定 `kokoro`）／`GEMINI_API_KEY`／
  `GEMINI_TTS_MODEL`（既定 `gemini-3.8-flash-lite-tts`）／`GEMINI_TTS_VOICE`（既定は公式の日本語向けの声から 1 つ選んで固定）／
  `GEMINI_TTS_SCOPE`（`audio` | `all`、既定 `audio` = まとめ・束・深掘りだけ）／
  `GEMINI_TTS_MAX_CHARS_PER_DAY`（既定 20000）／`GEMINI_TTS_TIMEOUT_MS`（既定 120000）。
  `TTS_PROVIDER=gemini` なのにキーが無い場合は、起動時に警告を 1 行出して Kokoro で動く。
- `GeminiNarrationProvider`（`narrationProvider.ts` に追加。`fetch` は引数で差し替えられるようにする）:
  1. 原稿を読み、既存の `normalizeNarrationForTts` は通さない（Kokoro 用の読み替えのため）。空なら例外。
  2. 3,000 文字を超える場合は段落の切れ目で分け、順に合成して ffmpeg でつなぐ。
  3. 応答から音声データ（base64）を取り出して `outputPath`（WAV）に書く。音声が無い応答は例外。
  4. HTTP エラーは、状態コードと本文の先頭 200 字だけを例外に入れる（URL やヘッダーは入れない）。
- 切り替えと控え: `getNarrationProvider(purpose: "audio" | "video")` に変え、
  Gemini の実装を「失敗したら Kokoro」の薄い包みで返す。`synthesize` の戻り値に、実際に使った提供元の ID を持たせる。
- 上限: `.runtime/tts-usage.json` に日付ごとの文字数を記録する（JST の日付）。超えたら Kokoro。
- `digestAudio.ts`: 戻り値に `provider` を足し、`upsertArticleAudio` で保存する。
- Viewer: 変更なし（任意で、音声の行に提供元を小さく出してもよい）。

## 7. タスク

- T1 公式ドキュメントの確認と、リクエスト／応答の形を `docs/gemini-tts-notes.md` に記録（確認日つき）。
- T2 設定と `GeminiNarrationProvider`。テスト（正常・HTTP エラー・音声なし・長文の分割・キーが出ないこと）。
- T3 控えへの切り替えと 1 日の上限。テスト。
- T4 `digestAudio.ts`・`firebaseArticleStore.ts`（`provider` の保存）。既存テストの更新。
- T5 文書（`README.md`・`.env.example`・`docs/architecture.md`）。

## 8. 確認（人が行う）

- 同じ原稿を両方で作り、読み間違いと聞きやすさを比べる。
- 音声の長さとファイルの大きさが上限（2.5MB）に収まるか。
- Google の管理画面で使用量を見て、想定どおりか。

## 9. 注意

- 料金と無料枠の条件は変わる。実装時点の公式の料金ページを確認し、`docs/gemini-tts-notes.md` に書く。
- キーの実値をコミットしない。テストは偽の値と差し替えた `fetch` で行う。
