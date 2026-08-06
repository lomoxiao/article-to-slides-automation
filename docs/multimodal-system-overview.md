# マルチモーダル生成システム構成概要（作図インプット）

このドキュメントは、**図を描く別エージェントへのインプット**である。
`multimodal-article-viewer`（以下 Viewer）からの生成依頼を起点に、
**スライド / 漫画 / 動画** の3系統のマルチモーダル出力がどう作られるかを、
ソース解析にもとづいて構造化して記述する。

- 対象リポジトリ: `article-to-slides-automation`（Node.js / TypeScript / ESM、常駐ローカルワーカー）
- 解析時点: 2026-08-06（`master` = `claude/article-slides-video-workflow-n3rcpa`）
- 記述の粒度: 「箱・矢印・ラベル」に落とせる粒度。末尾に作図ガイドあり。

---

## 0. 一行サマリ

> Viewer が Firebase RTDB に依頼レコードを1件書くと、ローカル常駐ワーカーが `child_added` で拾い、
> **同じ記事から Google スライド／NotebookLM 漫画デック／60秒解説MP4** を並行系統で生成し、
> 成果物URLと進捗を同じ記事ノード（`/articles/{articleId}`）へ書き戻す。
> LLM は従量課金APIではなく **ローカルCLI（`codex exec` / `claude --chrome`）** を叩く。

---

## 1. 全体像（レイヤ構成）

作図では、この5レイヤを上→下（または左→右）に並べるのが素直。

| # | レイヤ | 内容 |
|---|---|---|
| L1 | **依頼元（クライアント）** | Viewer（Web）、Slack（Slash Command / Bot投稿）、ローカルCLI（npm scripts） |
| L2 | **依頼バス（Firebase RTDB）** | `/generationRequests` に create-only で1件書かれる。状態の唯一の共有点 |
| L3 | **ローカル常駐ワーカー** | Fastify プロセス。Watcher + Socket Mode + 3つの直列キュー + 共有リソースゲート |
| L4 | **3系統パイプライン** | Slides / Manga / Video。各々ステージを持ち、途中経過を L2 に書き戻す |
| L5 | **外部サービス / ローカル実行基盤** | Codex CLI・Claude CLI・Playwright・HyperFrames・Kokoro TTS・FFmpeg・Google（Drive/Slides/GAS）・NotebookLM・Slack |

**重要な構図上のポイント**
- L3 は **ユーザーのローカルPC上で常駐**している。クラウドワーカーではない。
- L2（Firebase）が Viewer とワーカーの唯一の接点。Viewer はワーカーを直接叩かない。
- LLM 推論もレンダリングも **すべてローカル**（固定課金のCLI枠 / ローカルTTS / ローカルChrome）。
  外部の従量課金 LLM API は呼ばない。

---

## 2. ノード一覧（作図の「箱」）

IDは作図時の参照用。

### L1 依頼元
| ID | ラベル | 補足 |
|---|---|---|
| `N-VIEWER` | multimodal-article-viewer（Web） | 記事テキストを貼り、slides/manga/video のどれを作るか選ぶ |
| `N-SLACK-IN` | Slack（`/slides`, `[slide-generate]`, `[manga-generate]`, `[video-generate]`） | 既存の受付経路。Viewer 経路と並列に生きている |
| `N-CLI` | ローカルCLI（`npm run video:generate` 等） | 手動/デバッグ経路 |

### L2 依頼バス・永続化（Firebase Realtime Database）
| ID | パス | 役割 |
|---|---|---|
| `N-REQ` | `/generationRequests/{id}` | 依頼キュー。`status: queued → processing → done/failed` |
| `N-ARTICLES` | `/articles/{articleId}` | 記事ノード。`slides` / `manga` / `video` の3サブツリーに成果物と状態 |
| `N-SOURCES` | `/articleSources/{articleId}` | 抽出/投入本文（リーダービュー用、最大150k） |
| `N-DIAG` | `/artifactDiagnostics/{articleId}/{type}` | 技術的エラー詳細。**editor限定**（一般viewerには見せない） |
| `N-SESSION` | `/sessionStatus` | ログインセッション失効の記録（要手動対応の可視化） |

### L3 常駐ワーカー（`src/index.ts` が起動）
| ID | モジュール | 役割 |
|---|---|---|
| `N-FASTIFY` | `src/index.ts`（Fastify `/health`） | プロセス本体。起動時に3つの初期化を実行 |
| `N-WATCHER` | `domains/slides/generationRequestWatcher.ts` | **Viewer 依頼の入口**。`status=queued` を `child_added` 購読 |
| `N-SOCKET` | `slack/socketModeClient.ts` | Slack 依頼の入口（WebSocket outbound、公開HTTPエンドポイント無し） |
| `N-QSLIDE` | （Watcher 内の直列Promiseチェーン） | スライドは Watcher の中で **await** される（同期的） |
| `N-QMANGA` | `domains/manga/mangaGenerationQueue.ts` | 漫画の直列キュー（fire-and-forget） |
| `N-QVIDEO` | `domains/video/videoGenerationQueue.ts` | 動画の直列キュー（fire-and-forget） |
| `N-SEM` | `shared/resourceSemaphore.ts` | **プロセス全体で同時1件**の排他ゲート。**漫画と動画のみ**が通る |

### L4-A Slides パイプライン
| ID | モジュール | 役割 |
|---|---|---|
| `N-S-JOB` | `workflows/urlToGasSlides.ts` → `domains/slides/jobStore.ts` | `jobs/pending|processing|completed|failed/{jobId}/` を遷移 |
| `N-S-FETCH` | `shared/sourceAggregator.ts` | 本文取得（単一URL / 複数URL / Tavilyリサーチ / テキスト直投入） |
| `N-S-PROMPT` | `domains/slides/slidePrompts.ts` | `codex-prompt.md` を生成（テンプレ＋出力設定を埋め込み） |
| `N-S-CODEX` | `shared/codexRunner.ts` | `codex exec` を起動 → `slideData.json` |
| `N-S-CHART` | `domains/slides/chartRenderer.ts` | チャートJSON → **GAS で SVG 化** → **Playwright で PNG 化** |
| `N-S-GAS` | `domains/slides/gasSlides.ts` | まじん式 GAS Web App へ POST → Google スライド生成 |
| `N-S-TLDR` | `slideJobProcessor.ts` 内 | 完了後に best-effort で3行TLDRを Codex 生成 |

### L4-B Manga パイプライン
| ID | モジュール | 役割 |
|---|---|---|
| `N-M-JOB` | `domains/manga/mangaJobStore.ts` | `jobs/manga/{jobId}/` |
| `N-M-OUTLINE` | `domains/manga/mangaOutlineGen.ts` | **Step1（構成・キャラID・コマ割り）→ Step2（ネーム詳細化）** を Codex で2段実行 |
| `N-M-TPL` | `manga-templates/` | `prompts/01_,02_`、`art-styles/画風A〜G`、`character-sheets/*` |
| `N-M-DRIVE` | `shared/driveUploader.ts` | step1/step2 を **Google ドキュメント**として固定名 upsert |
| `N-M-NBLM3` | `domains/notebooklm/notebookLmPipeline.ts` | **Phase3**: NotebookLM ソース同期 + Step3 トリガ |
| `N-M-NBLM4` | `domains/notebooklm/notebookLmDeckRetrieval.ts` | **Phase4**: デック生成完了待ち → 共有URL取得 |
| `N-M-DRIVER` | `domains/notebooklm/notebookLmDriver.ts` | 主経路 = 決定論 Playwright（専用Chromeプロファイル） |
| `N-M-LEGACY` | `domains/notebooklm/notebookLmSync.ts` / `mangaDeckUrlFetcher.ts` | フォールバック = `claude --chrome`（Claude in Chrome拡張） |
| `N-M-LOCK` | `domains/notebooklm/nblmLock.ts` | NotebookLM 操作の排他ロック |

### L4-C Video パイプライン（今回追加した系統）
| ID | モジュール | 役割 |
|---|---|---|
| `N-V-JOB` | `domains/video/videoJobStore.ts` | `jobs/video/{jobId}/`（`audio/ project/ snapshots/ logs/ checkpoints/`） |
| `N-V-PLAN` | `domains/video/videoPlan.ts` | Codex + **strict JSON Schema** で VideoPlan v2（6〜8シーン）生成 |
| `N-V-MOTION` | `domains/video/motionPlan.ts` | Codex でリッチ図解ストーリーボード（11種の図解kind）生成 |
| `N-V-TTS` | `domains/video/narrationProvider.ts` + `scripts/kokoro-ja-tts.py` | **Kokoro-82M + Misaki 日本語G2P + UniDic** をローカルPythonで実行 |
| `N-V-CAP` | `domains/video/captionTiming.ts` | フレーズ単位WAVの**実測尺**から字幕キューを確定（音声認識を使わない） |
| `N-V-FFMPEG` | `domains/video/media.ts` | FFmpeg/FFprobe（尺計測・`atempo`・WAV連結・最終MP4検査） |
| `N-V-COMP` | `domains/video/composition.ts` | HyperFrames プロジェクト（`index.html` + GSAP + Noto Sans JP + narration.wav）を生成 |
| `N-V-HF` | `domains/video/hyperframesCli.ts` | HyperFrames CLI `0.7.87` を `lint → check --strict → snapshot → render` の順で実行 |
| `N-V-UP` | `shared/driveBinaryUploader.ts` | MP4 / project.zip / manifest.json を Drive へ upsert |

### L5 外部・ローカル実行基盤
| ID | ラベル | 使う系統 |
|---|---|---|
| `N-X-CODEX` | **Codex CLI**（`codex exec`、既定モデル `gpt-5.5`、サンドボックス実行） | Slides / Manga / Video 全部 |
| `N-X-CLAUDE` | **Claude CLI**（`claude --chrome`） | Manga（NotebookLM操作のフォールバックのみ） |
| `N-X-EXTRACT` | `@local/content-extractor`（別リポジトリ、Playwright同梱） | Slides / Manga / Video の本文取得 |
| `N-X-TAVILY` | Tavily Search API | Slides のリサーチモードのみ |
| `N-X-PW` | Playwright Chromium | チャートPNG化 / NotebookLM操作 / ログイン必須サイト取得 |
| `N-X-HF` | HyperFrames + ヘッドレスChrome | Video レンダリング |
| `N-X-KOKORO` | Kokoro TTS（ローカルPython venv） | Video ナレーション |
| `N-X-FFMPEG` | FFmpeg / FFprobe | Video 音声・最終検査 |
| `N-X-GAS` | Google Apps Script Web App（まじん式テンプレート） | Slides のデック生成、チャートSVG変換 |
| `N-X-SLIDES` | Google スライド / Google Drive | Slides 成果物 |
| `N-X-DRIVE` | Google Drive | Manga（Docs）/ Video（MP4等） |
| `N-X-NBLM` | NotebookLM（ブラウザ自動操作、公式APIなし） | Manga デック生成 |
| `N-X-SLACK` | Slack API（`chat.postMessage`） | 全系統の完了/失敗通知 |

---

## 3. 依頼受付フロー（Viewer 起点・すべての系統の共通前段）

```
Viewer ──(create-only write)──▶ /generationRequests/{id}
                                   { ownerUid, kind:"text", text, title?,
                                     slides?, manga?, video?, audience?, focus?,
                                     mangaOptions?{artStyle A-G, treatment A-C, genre},
                                     status:"queued", trigger:{provider:"web"} }
```

ワーカー側（`generationRequestWatcher.ts`）の処理順序：

1. `orderByChild("status").equalTo("queued")` を `child_added` 購読
2. **プロセス内 dedupe**（直近500 requestId の bounded set）
3. **`status` を transaction で `queued → processing` にクレーム**（多重起動・再送に対する排他）
4. Zod で**再検証**（Rules を信頼しつつ、Rules事故や未知キーに備える防御的検証）
   - `slides|manga|video` の少なくとも1つが true
   - `manga === Boolean(mangaOptions)`（過不足を拒否）
5. `createTextArticleIdentity(text)` で `text:txt_xxxxxxxxxxxx` 形式の合成canonical URLを作る
   → **URLを持たないテキスト投入でも、URLキー前提の既存パイプラインをそのまま流用できる**
6. `registerArticle()` + `upsertArticleSource()` を `/articles` `/articleSources` へ
7. **video → manga → slides の順**にディスパッチ
   - `video`: `await enqueueVideoGeneration()`（ジョブ作成まで待ち、生成本体は裏で走る）
   - `manga`: `enqueueMangaGeneration()`（完全に fire-and-forget）
   - `slides`: **`await` して完了まで待つ**（Playwright preflight → ジョブ作成 → `processSlideJob`）
8. `status: "done"` + `articleId` を書き戻す（失敗時は `failed` + `error`/`errorCode`）

**再起動時の扱い**: 残留した `processing` は自動再実行せず `failed` に落とす（二重生成の回避。再実行は Viewer から再投稿）。

**作図上の注意**: 「slides だけ同期・manga/video は非同期」という非対称は、
Viewer の体感（slides依頼はリクエストが長く `processing` のまま）に直結するので図でも区別したい。

---

## 4. 3系統パイプライン

### 4-A. Slides（Google スライド）

```
本文取得 ─▶ codex-prompt.md ─▶ codex exec ─▶ slideData.json
                                                 │
                                      chartRenderer（任意）
                                        JSON ─(GAS)─▶ SVG ─(Playwright)─▶ PNG
                                                 │
                                     slideData.rendered.json
                                                 │
                                      GAS Web App へ POST（まじん式）
                                                 ▼
                                        Google スライド URL
                                                 │
                            ┌────────────────────┼────────────────────┐
                       /articles.slides      Slack通知          TLDR生成(Codex)
                                                                → /articles.tldr
```

- 入力バリエーション: 単一URL / 複数URL連結 / Tavilyリサーチ / **テキスト直投入**（Viewer経路）
- ジョブは `jobs/{pending,processing,completed,failed}/{jobId}/` をディレクトリ移動で遷移
- 事前ゲート: **Playwright Chromium preflight**（起動時に1回プローブ、依頼時にも `ensureSlidesRuntimeReady`）。
  失敗時は `PLAYWRIGHT_CHROMIUM_UNAVAILABLE` として、viewer には無害な日本語メッセージだけ出す
- `slideData.json` は**必ず配列であること**を検証してから GAS へ送る

### 4-B. Manga（NotebookLM スライドデック）

```
本文取得 ─▶ jobs/manga/{id}/source.txt
              │
              ├─ character-sheets/ 取り込み（ファイル名をStep1へ渡す）
              │
         Step1（構成・キャラID・コマ割り）  ← 01_プロンプト + 画風A〜G
              │  codex exec
              ▼
         Step2（ネーム詳細化）             ← 02_プロンプト + キャラシート対応表
              │  codex exec
              ▼
   step1-output.txt / step2-output.txt
              │
              ▼ Google ドキュメントとして固定名 upsert
        Google Drive（MANGA_DRIVE_FOLDER_ID）
              │
   ══════════ Phase3 ══════════
   NotebookLM ソース同期 + Step3 トリガ
     主経路: Playwright 決定論ドライバ（専用Chromeプロファイル、NOTEBOOKLM_NOTEBOOK_ID）
     代替  : claude --chrome（Claude in Chrome 拡張）
              │  トリガ前の artifact 一覧をスナップショット
   ══════════ Phase4 ══════════
   デック生成完了をポーリング（artifact 差分検出）→ 共有URL取得
              │
              ▼
      /articles.manga.url  +  Slack通知
```

- **NotebookLM に公式APIは無い**ので、この2フェーズはブラウザ自動操作。
  したがって「Googleログインの失効」が一級の失敗モードで、`action_required` + `sessionStatus` として明示される
- 失敗の切り分けが細かい: `signed_out` / `ui_mismatch` / `timeout` / `unreachable` / `nblm_unavailable` / `generation_failed`
  - `ui_mismatch` → `claude --chrome` へフォールバック
  - `timeout`/`unreachable` → ドライバ再起動リトライ
  - `signed_out` → 即 `action_required`（再ログイン→resumeで確実に回収できる状態）
- Drive登録・ソース登録・デック生成・URL取得を**個別ステージとして記録**する

### 4-C. Video（60秒解説MP4）— 今回追加した系統

```
[gate] VIDEO_GENERATION_ENABLED && 実行時マーカー検査（TTS/HyperFrames/pipelineVersion）
   │
本文取得 ─▶ source.txt
   │
   ▼ ① video_planning
 VideoPlan v2 生成（Codex + strict JSON Schema、失敗時1回フィードバック再試行）
   ・6〜8シーン / 総ナレーション 280〜340字 / 各シーン 35〜65字
   ・narration を 1〜3個の captionPhrases に分割（空白を除くと narration と完全一致）
   ・evidence は SOURCE からの完全一致引用（不一致なら近似修復、それでも駄目なら失敗）
   │
   ▼ MotionPlan 生成（rich時のみ / VIDEO_RICH_MOTION_ENABLED）
   ・topology/migration/cycle/loop/timeline/branch/cause-effect/layers/gates/metric/legacy
   ・非legacyを4つ以上・3種類以上、同種連続禁止・同種3回以上禁止
   ・失敗しても落とさず basic へ退避（理由を manifest へ記録）
   │
   ▼ ② video_tts
 フレーズ単位で Kokoro TTS → raw WAV → FFprobe で実測
   ・短すぎ（<1.5s相当）は隣接フレーズと結合して再TTS（最大8パス）
   ・総尺が 55〜65秒 から外れたら「文字数目標を再計算して plan を1回だけ作り直す」
     （表示メタ情報は据え置き、ナレーションと字幕だけ書き換える契約）
   ・最後に共通 atempo 係数（0.9〜1.1）を全フレーズへ適用
   │
   ▼ ③ video_captioning
 変換後WAVを再計測 → 累積値だけから CaptionCue を確定 → captions.json
   ・1キューは 1.5〜6秒。範囲外は CAPTION_DURATION_INVALID で停止
   ・**音声認識を一切使わない**（字幕は計画テキストと実測尺だけで作る）
   │
   ▼ ④ video_rendering
 HyperFrames プロジェクト生成（index.html + GSAP + Noto Sans JP + narration.wav / 全アセット同梱）
   lint ─▶ check --strict ─▶ snapshot ─▶ render
   ・rich でここが落ちたら → basic に作り直して再検証（同じ音声・字幕を再利用）
   ・出力 MP4 を FFprobe 検査（1920x1080 / H.264 / AAC / 尺 / サイズ上限）
   │
   ▼ ⑤ video_uploading
 Drive へ MP4 / project.zip / manifest.json を upsert → /articles.video.url + Slack通知
```

**動画系統だけが持つ設計要素（図で強調したい差分）**

| 要素 | 内容 |
|---|---|
| **チェックポイント再開** | `source / plan / storyboard / tts / captions / render` を `jobs/video/{id}/checkpoints/*.json` に記録。`inputHash` と **stepVersion** が一致し、成果物ファイルが実在してサイズ>0のときだけ再利用。工程の契約を変えたら stepVersion を上げて旧チェックポイントを無効化する |
| **二段フォールバック** | ①ストーリーボード生成失敗 → basic ②HyperFrames の strict 検査失敗 → basic に作り直して再検証。どちらも**音声と字幕は作り直さない** |
| **中断検知** | ワーカー起動時に `pending`/`processing` の動画ジョブを走査し、`WORKER_RESTARTED` として `action_required` に落とす（勝手に再開しない） |
| **決定論的な尺制御** | LLM に「60秒で」と頼むのではなく、**実測 → 再計画 → atempo** の3段で尺を物理的に合わせ込む |
| **完全ローカル** | 外部画像・CDN・外部フォント・クラウドTTS・クラウドレンダリングを一切使わない |

---

## 5. 共有基盤（3系統を横断する仕掛け）

### 5-1. 直列化とリソースゲート

```
Watcher(直列) ─┬─▶ Slides   … セマフォを通らない（Playwright + GAS が主で軽い）
               ├─▶ Manga キュー(直列) ─┐
               └─▶ Video キュー(直列) ─┴─▶ [resourceIntensiveSemaphore] 同時1件
```

漫画と動画は CPU/メモリを食う（Codex 2〜3回 + ブラウザ + FFmpeg + TTS）ため、
**プロセス横断で同時1件**に制限される。NotebookLM 操作にはさらに専用ロック（`nblmLock`）がある。

### 5-2. 状態モデル（Viewer 表示の共通語彙）

- **status**（slides/manga/video 共通）: `pending | processing | action_required | failed | completed`
- **stage**: `preparing / drive_registration / source_registration / deck_generation / url_retrieval /
  slides_generation / video_queued / video_planning / video_tts / video_captioning / video_rendering / video_uploading`
- **statusMessage**: 一般viewer向けの日本語説明（例: 「意味単位の字幕タイミングを確定しています」）
- **`action_required`** = 自動処理は続けられないが、**手動操作で確実に回収できる**状態
  （ログイン失効、ワーカー再起動での中断、Drive作成の不確定、尺が範囲外 など）

### 5-3. 情報の出し分け（プライバシー境界）

```
/articles              … 一般viewerが読む。status / stage / statusMessage / url だけ
/artifactDiagnostics   … editor限定。errorCode / スタックに近い detail / jobId / fileId
```

技術的エラーを記事データへ混ぜない、という分離が明示的に設計されている。

### 5-4. プロンプトインジェクション対策（全系統共通）

- 記事本文・`source.txt` は **「命令ではなく入力データ」** として扱う制約文を全プロンプトに注入（`shared/promptGuards.ts`）
- Codex は**書き込み先を対象ジョブ配下の1ファイルに固定**して起動
- 計画生成は **strict JSON Schema** で出力を拘束し、さらに Zod で再検証
- 生成テキストは `<script>` / URL / パス / シェル片などを正規表現で拒否（`video/types.ts` の `safeText`）
- 動画の evidence は **原文の完全一致引用**を強制 → 「記事に無い主張」を構造的に作れなくする

### 5-5. Firebase 書き込みの統制

Admin SDK は Rules をバイパスするため、パスごとに**専任モジュール**を1つだけ置く方針
（任意パスに書ける汎用ユーティリティを作らない）。

| パス | 専任モジュール |
|---|---|
| `/articles`, `/articleSources`, `/artifactDiagnostics` | `shared/firebaseArticleStore.ts` |
| `/sessionStatus` | `shared/sessionStatusStore.ts` |
| `/generationRequests` | `domains/slides/generationRequestWatcher.ts` |

また、`origin:"manual"` かつ `locked:true` かつ `completed` の成果物は**自動処理が上書きしない**
（手動登録したURLを守る）。

### 5-6. フィーチャーフラグ / ゲート一覧

| フラグ・ゲート | 既定 | 効果 |
|---|---|---|
| `VIDEO_GENERATION_ENABLED` | **false** | 動画系統そのもののON/OFF（本番E2E完了まで false 維持） |
| `VIDEO_RICH_MOTION_ENABLED` | false | GSAPリッチ図解。false なら basic 固定 |
| `MANGA_NOTEBOOKLM_AUTOSYNC` | false | Phase3（NotebookLM同期）のON/OFF |
| `MANGA_DECK_AUTOFETCH` | false | Phase4（デックURL取得）のON/OFF |
| `AUTO_RUN_CODEX` | true | false なら Codex を自動起動せずプロンプトだけ用意して停止 |
| Playwright preflight | 起動時プローブ | 不可ならスライド依頼を安全に拒否 |
| Video runtime/browser マーカー | 明示実行が必要 | `jobs/video/.runtime-ready.json` / `.browser-ready.json` の内容（HyperFramesバージョン・TTSプロバイダ・pipelineVersion）が一致しないと起動しない |

---

## 6. 3系統の比較（1枚に収めるならこの表が骨）

| 観点 | **Slides** | **Manga** | **Video** |
|---|---|---|---|
| 成果物 | Google スライド | NotebookLM スライドデック | 1080p MP4（55〜65秒） |
| 生成エンジン | Codex → GAS（まじん式） | Codex 2段（Step1/Step2）→ NotebookLM | Codex 2段（Plan/Storyboard）→ HyperFrames |
| LLM 呼び出し | 1回（+TLDR 1回） | 2回 | 2回（+尺リカバリ時に再計画1回） |
| ブラウザ利用 | チャートPNG化 | NotebookLM 自動操作（主役） | HyperFrames レンダリング |
| 音声 | なし | なし | Kokoro TTS（ローカル） |
| Viewer からの実行 | **同期（await）** | 非同期 | 非同期 |
| 排他 | なし | セマフォ + NBLMロック | セマフォ |
| 再開性 | ジョブ再実行（`jobs:process`） | `manga:resume` | **チェックポイント再開**（工程単位） |
| 主な失敗モード | Chromium未整備 / GAS応答なし | Googleログイン失効 / UI変更 | 尺レンジ外 / strict検査不合格 / Drive不確定 |
| 保存先 | Google Drive（スライド） | Google Drive（Docs）+ NotebookLM | Google Drive（MP4/zip/manifest） |

---

## 7. 作図ガイド（描くエージェント向けの指示）

### 7-1. 推奨レイアウト

**縦3バンド + 横3レーン**の構図を推奨。

```
┌─────────────────────────────────────────────────────────────┐
│ [上] 依頼元:  Viewer(Web)   Slack   ローカルCLI              │
└──────────────────────┬──────────────────────────────────────┘
                       │ create-only write
┌──────────────────────▼──────────────────────────────────────┐
│ [中上] Firebase RTDB:  /generationRequests                   │
│                        /articles  /articleSources  /diag     │
└──────────────────────┬──────────────────────────────────────┘
        child_added(queued) │            ▲ 状態・成果物URLの書き戻し
┌──────────────────────▼────────────────┴────────────────────┐
│ [中] ローカル常駐ワーカー（1プロセス）                        │
│   Watcher / SocketMode ─▶ [直列キュー] ─▶ [同時1件セマフォ] │
├──────────────┬──────────────┬───────────────────────────────┤
│ [下] Slides   │  Manga        │  Video                       │
│  レーン       │  レーン       │  レーン（今回追加）           │
└──────────────┴──────────────┴───────────────────────────────┘
                       │ 各レーンから外部サービスへ
┌──────────────────────▼──────────────────────────────────────┐
│ [最下] Codex CLI / Claude CLI / Playwright / HyperFrames /    │
│        Kokoro TTS / FFmpeg / GAS / Google Drive・Slides /     │
│        NotebookLM / Slack                                     │
└──────────────────────────────────────────────────────────────┘
```

### 7-2. 色・強調の指針

- **3系統は別色**にする（例: Slides=青系 / Manga=橙系 / **Video=緑または紫（新規なので最も彩度を高く）**）
- **ローカル実行の境界を明示**する。「この点線の内側は全部ユーザーのPCで動く」が本システムの最大の特徴
- **Firebase を唯一の接点**として描く（Viewer とワーカーの間に直接の矢印を引かない）
- **セマフォ（同時1件）** は、Manga と Video のレーンだけを絞る「くびれ」として描くと構造が伝わる
- **フォールバック矢印は破線**（rich→basic、Playwright→claude --chrome）
- **`action_required` への遷移**は別色（黄／警告色）で。これは「失敗」ではなく「人が触れば戻せる」状態

### 7-3. ラベルに入れたい数値・固有名詞

- HyperFrames `0.7.87` / `lint → check --strict → snapshot → render`
- Kokoro-82M + Misaki(日本語G2P) + UniDic
- 動画: 55〜65秒 / 1920x1080 / H.264+AAC / 6〜8シーン / 字幕1.5〜6秒 / atempo 0.9〜1.1
- VideoPlan schema v2、MotionPlan schema v1、manifest schemaVersion 2 / pipelineVersion 3
- 漫画: 画風A〜G / treatment A〜C / Step1・Step2 / Phase3・Phase4
- Codex 既定モデル `gpt-5.5`、Claude CLI は `--chrome` 用途のみ

### 7-4. 描かない方がよいもの（ノイズ）

- 旧 HTTP webhook 経路（`src/routes/slack.ts`）は **2026-07 に削除済み**。描かない
- `video_transcribing` ステージは型に残っているが**現行フローでは使われない**（音声認識を廃した名残）
- HyperFrames 同梱の eSpeak ベース TTS は**意図的に未使用**（TTSはKokoroに一本化）
- `src/routes/` や README のディレクトリ構成節は古い。正は `src/domains/{slides,manga,notebooklm,video}` + `src/shared` + `src/workflows`

### 7-5. 図で伝わってほしい主張（優先度順）

1. **1本の依頼から3種のモダリティが分岐する**（同じ記事ノードに3つの成果物がぶら下がる）
2. **すべてローカルで完結する**（従量課金APIなし・クラウドレンダリングなし）
3. **動画系統は他2つより工程が深く、決定論的な検査と再開機構を持つ**
4. **失敗は「失敗」と「人が触れば戻せる（action_required）」に分けて設計されている**
5. **重い処理は同時1件に絞られている**（ローカルPCのリソースが律速）
