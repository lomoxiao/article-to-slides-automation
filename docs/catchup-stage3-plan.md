# 段階3 実装計画：取り込み工程の独立と入口の一本化

作成: 2026-11-15
位置づけ: 「キャッチアップ基盤 成長提案書」コースB・段階3（リファクタリング項目 R2・R3・R4）。
前提: **段階1（`catchup-stage1-plan.md`）が完了していること。** 段階1で入る品質判定（`quality`）、
`SourceUnavailableError`、`sanitizeArticleUrl` を使う。段階2とは独立。
実装担当: コーディングエージェントを想定。ワークスペース直下の `AGENTS.md` と各リポジトリの規約に従うこと。

## 1. 目的

1. **取り込みを 1 か所にまとめる。** URL を受けたら本文を 1 回だけ取得して保存し、
   スライド・漫画・動画・Reader は保存済みの本文を読む。
2. **依頼の入口を 1 本にする。** Viewer からの URL 投入を、GAS → Slack 経由から、
   テキスト投入と同じデータベースの依頼キュー（`/generationRequests`）経由に変える。
3. **AI 実行を同時に 1 本に制限する。** あわせて、再起動で宙に浮いたスライドジョブを片付ける。

## 2. 現状（コードで確認済み）

- 本文取得 `fetchSourceContent` の呼び出し箇所:
  `domains/slides/slideJobProcessor.ts`、`domains/manga/articleToManga.ts`、`domains/video/videoPipeline.ts`、
  `scripts/readerRefresh.ts`、`workflows/urlToSlides.ts`、および `shared/sourceAggregator.ts` 内の
  `fetchMultipleSourceContent` と `fetchResearchContent`。
- どの生成処理も、ジョブに `sourceText` があれば取得を飛ばしてそれを使う（テキスト投入で使用中）。
- 依頼キュー `domains/slides/generationRequestWatcher.ts` は `kind: "text"` だけを受け付ける。
  スライド・漫画・動画の 3 つを振り分けているが、置き場所は `domains/slides/`。
- Viewer の URL 投入（`app.js` の `submitGenerationRequest`）は GAS の `requestGeneration` を呼び、
  GAS が Slack に投稿し、常駐プロセスが Slack から受け取る。
- 待ち行列: 依頼受付・漫画・動画がそれぞれメモリ上で 1 件ずつ処理。Slack 経由のスライドは待ち行列を通らず直接実行。
  `codex exec` の同時実行数を制限する仕組みはない。
- 再起動時: 動画（`markInterruptedVideoJobs`）と依頼キュー（`recoverOrphanedRequests`）は中断を検出するが、
  スライドは検出しない。`jobs/processing` に 9 件残っている（2026-04〜07 の分）。
- 複数 URL のスライド生成では、連結した本文（`mergedBody`）を 1 本目の記事の保存済み本文として
  上書きしている（`slideJobProcessor.ts` の `prepareSlideDataGeneration`）。

## 3. 完了条件

1. Viewer から URL を投入すると、GAS と Slack を通らずに生成が始まる。
2. 同じ記事でスライドと漫画を続けて依頼しても、外部サイトへの本文取得は 1 回だけ（ログで確認できる）。
3. 本文が取れなかった場合、依頼は「本文が取れていません」で止まり、どの生成も始まらない。
4. `codex exec` が同時に 2 本走らない（スライド・漫画・動画・3 行要約・1 日のまとめのどの組み合わせでも）。
5. 常駐プロセスの起動時に、`jobs/processing` に残ったスライドジョブが失敗扱いに移され、残留が 0 件になる。
6. Slack からの依頼（`/slides`、`[slide-generate]`、`[manga-generate]`、`[video-generate]`）が従来どおり動く。
7. テキスト投入が従来どおり動く。
8. 自分の PC や家庭内ネットワークを指す URL の依頼が拒否される。
9. 各リポジトリで `typecheck`、`test`（automation は `lint` も）が通る。

## 4. スコープ外

- 束（複数記事をまとめる依頼）。段階4。依頼の種類は後から足せる形にしておくだけにする。
- リサーチモード（`fetchResearchContent`）。挙動を変えない。
- ジョブ保存形式の統一、待ち行列そのものの作り直し。
- GAS プロジェクト側の変更（スライド閲覧の API として引き続き使う）。
- Viewer の全面的なファイル分割。

## 5. タスク

実施順は T1 → T2 → T3 → T4 → T5 → T6 → T7。

### T1. AI 実行の同時実行を 1 本に制限（R4 縮小版）

- 対象: `shared/codexRunner.ts` の `runCodexExec`（すべての Codex 実行がここを通る）と、
  `shared/claudeRunner.ts` の実行関数。
- 変更: `shared/resourceSemaphore.ts` の仕組み（`AsyncSemaphore`）を再利用できる形で export し、
  Codex 用と Claude 用にそれぞれ 1 つずつ用意して、実行を `runExclusive` で囲む。
- 注意:
  - 既存の `resourceIntensiveSemaphore`（漫画・動画の重い処理用）とは別物にする。
    取得順は必ず「重い処理用 → AI 実行用」とし、AI 実行用を持ったまま重い処理用を取りに行かないこと（固まるのを防ぐ）。
    漫画・動画の中から Codex を呼ぶ箇所がこの順になっていることを確認する。
  - 実行のタイムアウトは、順番待ちの時間を含めず、実行開始から数える。
- テスト: 2 つ同時に呼んで、2 つ目が 1 つ目の終了後に始まることを確認する単体テスト（実 CLI は呼ばない）。

### T2. スライドジョブの再起動時回収（R4 縮小版）

- 新規関数 `markInterruptedSlideJobs()`（`domains/slides/jobStore.ts` 付近）。動画の `markInterruptedVideoJobs` と同じ考え方。
  - `jobs/processing` にあるスライドジョブのうち、`updatedAt` が 30 分以上前のものを対象にする
    （手動の `jobs:process` と重なった場合に実行中のジョブを巻き込まないため）。
  - ジョブを `failed` に移し、`error` に「再起動により中断されました」と記録する。
  - Viewer 側の成果物状態は、**現在 `processing` のときだけ** `action_required`
    「再起動により中断されました。再生成してください」に更新する。すでに完了や手動登録になっている記事は触らない。
- `src/index.ts` の起動処理で、動画の回収の隣で呼ぶ。
- これで、残っている 9 件も初回起動時に片付く。実行前に 9 件の一覧（ID・URL・日付）を報告に含めること。
- テスト: `jobStore.test.ts` に、対象の判定（30 分の境界、成果物状態による分岐）のテストを追加。

### T3. 取り込み工程の新設（R2）

- 新規 `src/domains/ingest/ingestArticle.ts`:

  ```ts
  export type IngestResult = {
    articleId: string;
    canonicalUrl: string;
    title: string;
    text: string;
    quality: { verdict: "full" | "partial"; chars: number; reasons: string[] };
    readerFormatVersion?: number;
    readerFormatMethod?: string;
    reused: boolean;   // 保存済み本文を再利用したか
  };
  export async function ingestArticle(url: string, options?: { force?: boolean }): Promise<IngestResult>;
  ```

- 動作:
  1. `sanitizeArticleUrl`（段階1）と、T5 の公開 URL チェックを通す。
  2. `force` でなければ、`/articleSources/{articleId}` を読み、`extractedAt` が再利用期間内
     （設定 `INGEST_REUSE_HOURS`、既定 24）で判定が `full` なら、それを返す（`reused: true`）。外部サイトへは行かない。
  3. それ以外は `fetchSourceContent(url)` を呼ぶ。段階1の関門により、取れなければ `SourceUnavailableError` が投げられる。
  4. 取れたら `upsertArticleSource` で保存する（判定つき。段階1 T6 で追加した `quality` を使う）。
  5. 記事の取り込み状態を `/articles/{articleId}/ingest` に書く:
     `{ verdict, chars, checkedAt, message? }`。失敗時も `verdict: "failed"` と利用者向けの `message` を書いてから例外を投げ直す。
     書き込みは `shared/firebaseArticleStore.ts` に新設する `upsertArticleIngest` で行う。
  6. 同じ記事への取り込みが同時に呼ばれた場合は、1 回にまとめる（記事 ID ごとに実行中の Promise を共有する）。
- 保存済み本文を読む関数 `getArticleSource(url)` を `firebaseArticleStore.ts` に追加する。
- 呼び出し側の置き換え（`fetchSourceContent(url)` → `ingestArticle(url)`）:
  - `domains/slides/slideJobProcessor.ts` の `fetchContentForJob`（単一 URL の分岐）
  - `domains/manga/articleToManga.ts`
  - `domains/video/videoPipeline.ts`
  - `workflows/urlToSlides.ts`
  - `scripts/readerRefresh.ts` は `ingestArticle(url, { force: true })`
  - `shared/sourceAggregator.ts` の `fetchMultipleSourceContent` は、URL ごとに `ingestArticle` を呼ぶ形にする
    （記事ごとに本文が保存される。段階4の束の土台になる）。1 本でも失敗したら全体失敗、という現在の挙動は変えない。
  - `fetchResearchContent` は変更しない。
- あわせて直す点: 複数 URL のとき、連結本文を 1 本目の記事の保存済み本文として上書きしている処理
  （`prepareSlideDataGeneration` の `upsertArticleSource(sourceUrl, content.mergedBody, …)`）をやめる。
  単一 URL のときは `ingestArticle` が保存するので、ここでの保存は不要になる。テキスト投入の保存は従来どおり。
- テスト: `ingestArticle.test.ts`（再利用する／しないの分岐、`force`、失敗時の状態書き込み、同時呼び出しの集約）。
  Firebase と取得は差し替え可能にしてテストする。

### T4. 依頼受付の整理と URL 対応（R3、automation 側）

- 置き場所の移動: `domains/slides/generationRequestWatcher.ts` を `src/requests/` に移す
  （関連テスト `generationRequestWatcher.video.test.ts` も移す）。`src/index.ts` の import を直す。
- 依頼の種類を広げる。`kind` で分岐する形（zod の判別共用体）にし、後から `bundle` を足せるようにする。

  ```ts
  // 共通: ownerUid, slides, manga, video, audience?, focus?, mangaOptions?, status, createdAt, trigger
  { kind: "text", title?, text }
  { kind: "url",  urls: string[] }   // 1〜3 件。漫画・動画を含む依頼は 1 件のみ
  ```

- 振り分け処理を共通化する。新規 `src/requests/dispatchGeneration.ts` に
  「記事を登録し、取り込み、スライド・漫画・動画を待ち行列に積む」処理をまとめ、
  依頼キューと Slack（`slack/socketModeClient.ts`）の両方から呼ぶ。Slack の受付応答と通知の挙動は変えない。
- URL 依頼の処理:
  1. URL を掃除し、公開 URL チェック（T5）を通す。通らなければ `failed`、`statusMessage` に理由。
  2. `registerArticle` で記事を登録する。
  3. 単一 URL の場合は `ingestArticle` を呼び、結果を依頼に書く:
     `ingest: { verdict, chars }`（Viewer が「本文を取得しました」を表示するため）。
     `SourceUnavailableError` なら依頼を `failed` にし、`errorCode: "SOURCE_UNAVAILABLE"` と `statusMessage` を書く。
  4. 取り込みに成功したら、`sourceText` と `sourceTitle` を付けて各生成を積む（URL は実際の URL のまま渡す）。
  5. 複数 URL（スライドのみ）は、従来どおり `urls` を渡す。取得はスライドジョブの中で `ingestArticle` 経由になる（T3）。
- Slack 経由の依頼も同じ共通処理を通るので、取り込みの関門と再利用が同じように効く。
- テスト: 受付スキーマ（text / url、件数、漫画・動画と件数の制約）、振り分け（取り込み失敗時に何も積まれない）。

### T5. URL の入力チェック

- `src/utils/url.ts` に `assertPublicHttpUrl(url)` を追加する。次を拒否する:
  - `http` / `https` 以外。
  - 長さ 2,048 文字超。
  - ホスト名が `localhost`、ドットを含まない名前、`.local`、`.internal`、`.lan` で終わるもの。
  - IP アドレス直指定のうち、`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、
    `169.254.0.0/16`、`0.0.0.0`、`::1`、`fc00::/7`、`fe80::/10`。
- 適用箇所: `ingestArticle` の入口（すべての経路に効く）と、依頼受付（早めに分かりやすく失敗させるため）。
- 限界（報告に明記すること）: ホスト名を名前解決した先が内部アドレスになる場合までは防がない。
  個人利用で依頼者が本人に限られるため、この範囲とする。
- テスト: `utils/url.test.ts` に拒否・許可の例を追加。

### T6. アクセスルールと Viewer（multimodal-article-viewer）

- `database.rules.json` の `generationRequests`:
  - `kind` は `'text'` または `'url'`。
  - `kind` が `'text'` のとき `text` が必須で `urls` は無し。`'url'` のとき `urls/0` が必須で `text` は無し。
  - `urls` の各要素は文字列、2,048 文字以内、`http://` または `https://` で始まる。4 件目（`urls/3`）は不可。
  - 漫画または動画が真のときは `urls/1` を不可とする。
  - 既存の制約（本人の `ownerUid`、`status` は `queued`、`trigger/provider` は `web`、新規作成のみ）は変えない。
  - `tests/rules.contract.test.mjs` を更新する。**Rules の本番反映は人が行う。**
- `app.js`:
  - `submitGenerationRequest` の URL 分岐を、GAS 呼び出し（`apiClient.post("requestGeneration", …)`）から、
    依頼キューへの書き込みに変える。`submitTextGenerationRequest` と共通化する。
    書き込む形は `{ kind: "url", urls: [url], slides, manga, video, audience?, focus?, mangaOptions? }`。
    既存の `mangaArtStyle` / `mangaTreatment` / `mangaGenre` は、テキスト投入と同じ `mangaOptions` の形に揃える。
  - `watchGenerationRequestStatus` を URL 依頼にも使う。表示する文言:
    - `ingest` が書かれた時点: 「本文を取得しました（全文・4,936 文字）」／「本文の一部のみ取得できました（…）」
    - `failed` かつ `errorCode === "SOURCE_UNAVAILABLE"`: `statusMessage` を表示し、テキスト投入へ進むボタンを出す（段階1 T8 のボタンを流用）。
    - `done`: 「生成依頼を受け付けました」（URL 依頼では生成が後から完了するため、テキスト投入の「完了しました」とは文言を分ける）。
  - GAS 経由の投入コードは、設定 `USE_GAS_GENERATION`（`config.js`、既定 false）で残す。7 で削除する。
  - 記事の詳細画面に、取り込み状態（`article.ingest`）を小さく表示する（全文／一部／取れていません）。
- テスト: `tests/viewer.spec.js` に、URL 依頼が依頼キューに書かれること、取り込み失敗の表示のケースを追加。

### T7. 切り替えと後片付け

1. 人が Rules を本番に反映する。
2. 人が Viewer から URL 投入を行い、完了条件 1〜3・6〜8 を確認する。
3. 確認後、`app.js` の GAS 経由の投入コードと `USE_GAS_GENERATION` を削除する。
   GAS プロジェクト側と、Slack の `[slide-generate]` 受付は残す。
4. 文書の更新: `README.md` の「GAS Viewer連携」節、`docs/architecture.md`、`.env.example`（`INGEST_REUSE_HOURS`）。

## 6. コミットの区切り

1. automation: T1（AI 実行の制限）
2. automation: T2（スライドの回収）
3. automation: T3（取り込み工程）
4. automation: T5（URL チェック）
5. automation: T4（依頼受付）
6. viewer: T6（Rules と画面）
7. viewer + automation: T7（後片付け。人の確認のあと）

T1 と T2 は他と独立しているので、段階1・2 の作業と並行して先に入れてもよい。
push と Rules のデプロイはエージェントが行わない。

## 7. 人が決めること・行うこと

| 項目 | 既定（この計画での扱い） |
|---|---|
| 保存済み本文を再利用する期間 | 24 時間（`INGEST_REUSE_HOURS`） |
| 判定が「一部」の本文を再利用するか | しない（毎回取り直す） |
| GAS 経由の投入コードを消す時期 | T7 の確認が済んだら |
| Rules の本番反映 | T6 のあとに人が行う |

## 8. 報告に含めること

- 変更したファイルの一覧（リポジトリ別）。
- `jobs/processing` に残っていた 9 件の一覧と、回収後の状態。
- 漫画・動画から Codex を呼ぶ箇所の、2 つの制限の取得順の確認結果（T1）。
- 完了条件 1〜9 の達成状況（人の確認が要るものはその旨）。
- T5 の限界の記載。
- 計画どおりにできなかった点と、その理由。
