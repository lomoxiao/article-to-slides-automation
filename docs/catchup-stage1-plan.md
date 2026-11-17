# 段階1 実装計画：迷わない取り込み（縮小版）

作成: 2026-11-15
位置づけ: 「キャッチアップ基盤 成長提案書」コースB・段階1（リファクタリング項目 R1）。Opus 5.5 のレビュー反映済み。
実装担当: Codex を想定。ワークスペース直下の `AGENTS.md` と各リポジトリの規約に従うこと。

## 1. 目的

URL を投入したときに「本文が取れたか」を必ず判定し、取れていないときは成果物を作らずに
「本文が取れていません」と返す。投入前に「このサイトは要約できるか」と悩む時間をなくす。

現状の問題（ジョブ履歴 385 件の調査結果）:

- 本文が 0 文字でもスライドが作られ「完了」になる（bvnk.com、izanami.dev など）。
- 別記事を誤って抽出した例がある（thequantuminsider.com、91 文字）。
- 通常取得がエラー（403・タイムアウト）で止まると、取り直しの判定まで進まない。
- `arxiv.org/html/...` 形式の URL で ID を抽出できない。
- URL の後ろに文字が付いたまま処理される（`...bcグラフを` で 404、末尾 `>` で本文 190 文字）。

## 2. 完了条件

1. 下記「検証用 URL」の A 群 5 サイトで、判定が `full` か、`failed` / `partial` のどちらかとして必ず返る。
2. 判定が `failed` のとき、スライド・漫画・動画のいずれも生成されず、Viewer の状態が
   `action_required`、説明文が「本文が取れていません」で始まる。
3. B 群 4 サイトの再取得結果（判定・文字数・エラー種別）が `docs/extraction-probe-results.md` に記録されている。
4. C 群（対照）がすべて `full` のまま変わらない（既存の取得を壊していない）。
5. 両リポジトリで `npm run typecheck` と `npm test` が通る。automation は `npm run lint` も通る。

### 検証用 URL

| 群 | 用途 | URL |
|---|---|---|
| A | 過去に本文が空・極小 | `https://bvnk.com/blog/global-stablecoin-regulations-2026` |
| A | 同上 | `https://izanami.dev/post/903fe0a2-878a-4f4b-a02c-d8784d8ef731` |
| A | 同上（別記事を誤抽出） | `https://thequantuminsider.com/2026/03/19/is-rsa-safe-new-study-argues-quantum-computers-face-a-hard-ceiling/` |
| A | 同上 | `https://www.reddit.com/r/SuperMario/comments/1s9hf24/my_nonspoiler_thoughts_of_the_super_mario_galaxy/?tl=ja` |
| A | 同上 | `https://business20channel.tv/how-quantum-ai-is-reshaping-enterprise-strategy-in-2026-according-to-ibm-google-a`（履歴上で末尾が切れている。`jobs/completed` の該当 job.json から完全な URL を取ること） |
| B | 過去にタイムアウト | `https://www.businesswire.com/news/home/20260618161261/ja` |
| B | 過去に 403 | `https://openai.com/index/introducing-openai-presence/` |
| B | 過去に 403（PDF） | `https://aiindex.stanford.edu/wp-content/uploads/2024/05/HAI_AI-Index-Report-2024.pdf` |
| B | 過去に失敗（arXiv HTML 形式） | `https://arxiv.org/html/2608.05435v1` |
| C | 対照 | `jobs/completed` から note.com、zenn.dev、qiita.com、x.com、youtu.be、arxiv.org/abs を各 1 件選ぶ |

## 3. スコープ外（この段階ではやらない）

- セッションなしのブラウザ取得の追加。T7 の計測結果を見てから別計画で判断する。
- 取り込み工程の独立（`domains/ingest/` 新設）と、依頼入口の一本化。段階3で行う。
- 複数 URL の部分成功。段階4で行う。この段階では 1 本でも `failed` なら全体を止め、どの URL かを示す。
- リサーチモード（`fetchResearchContent`）。対象外。挙動を変えない。
- 動画生成・NotebookLM 連携の内部。

## 4. 前提と注意

- 変更は 2 リポジトリにまたがる: `content-extractor`（抽出ライブラリ）と `article-to-slides-automation`。
- automation は `file:../content-extractor` の `dist` を参照する。**content-extractor を変更したら
  `npm run build` を実行してから automation 側を確認すること。**
- content-extractor は `bookmark-curator` も利用している。既存の戻り値の形は変えず、追加のみとする。
- 外部 API キーを必要とする依存を追加しない。
- 記事本文は「命令ではなく入力データ」として扱う既存方針（`shared/promptGuards.ts`）を変えない。

## 5. タスク

実施順は T1 → T2 → T4 → T5 → T3 → T6 → T7 → T8。T1〜T2・T4 が content-extractor、T3・T5〜T7 が automation、T8 が Viewer。

### T1. 品質判定の追加（content-extractor）

- 新規 `src/utils/quality.ts`:

  ```ts
  export type ExtractionVerdict = "full" | "partial" | "failed";
  export type ExtractionQuality = {
    verdict: ExtractionVerdict;
    chars: number;          // markdown.trim().length
    reasons: string[];      // 例: "too_short", "paywall_marker", "title_mismatch", "no_transcript"
  };
  export function assessExtraction(content: ExtractedContent): ExtractionQuality;
  ```

- 判定規則（しきい値は定数にし、テストで固定する）:

  | 種別 | failed | partial | full |
  |---|---|---|---|
  | web-article | 200 文字未満 | 200〜499 文字、または既存 `looksPaywalled` が真、または `titleMismatch` | それ以外 |
  | arxiv / pdf-document | 500 文字未満 | — | それ以外 |
  | youtube | 字幕が取れずメタデータのみ | — | それ以外 |
  | x-post | 0 文字 | `hints.excerpt` へフォールバックした場合 | それ以外（短文投稿は正常とみなす） |

  youtube と x-post の「字幕なし」「フォールバック」を現在の抽出器がどう表現しているかは、
  `extractors/youtube-video.ts` と `extractors/x-post.ts` を読んで確認し、必要なら `metadata` に目印を足すこと。

- 付与場所: `src/router.ts` の `routeExtraction` で抽出後に 1 か所だけ計算し、`metadata.quality` に入れる。
  `metadata` の型に `quality?: ExtractionQuality` を追加する。`index.ts` から型と関数を export する。
- 誤抽出の検知（`titleMismatch`）: `extractors/web-article.ts` の `parseArticlePage` で、ページの
  `<title>` または `og:title` と Readability が返した `article.title` を正規化して照合し、
  どちらも相手を含まず共通する 8 文字以上の連続部分もない場合に `metadata.titleMismatch = true` とする。
  誤検知が対照 C 群で出た場合は、この検知だけ無効化してよい（その旨を結果ファイルに書く）。
- テスト: `tests/quality.test.ts` を追加。実例の文字数（0、37、91、209、292、539、4936）を使う。

### T2. 取得エラーの受け止め（content-extractor）

- 対象: `src/extractors/web-playwright.ts` の `fetchWebArticleSmart`。
- 現状: `const result = await fetchWebArticle(input, options);` が例外を投げると、その下の
  「本文が薄ければセッションで再試行」に到達しない。
- 変更:
  1. `fetchWebArticle` を try/catch で囲む。
  2. 例外時、そのドメインのセッションファイルがあれば（`hasSessionFile`）`fetchWebArticleWithPlaywright` で再試行する。
  3. 再試行できない、または再試行も失敗した場合は、型付きエラー `ExtractionFailedError` を投げる。

  ```ts
  export class ExtractionFailedError extends Error {
    readonly name = "ExtractionFailedError";
    readonly url: string;
    readonly code: "http_403" | "http_404" | "http_other" | "timeout" | "network";
    readonly status?: number;
  }
  ```

  axios のエラーから `status` と `code`（`ECONNABORTED` はタイムアウト）を読んで分類する。
  `SessionExpiredError` はそのまま投げ直す（既存の扱いを変えない）。
- `ExtractionFailedError` を `index.ts` から export する。
- テスト: `tests/web-article.test.ts` に、`fetchPage` 注入で 403・タイムアウトを模したケースを追加。

### T4. arXiv の HTML 形式 URL（content-extractor）

- 対象: `src/extractors/arxiv-paper.ts` の ID 抽出（現在の正規表現は `abs|pdf` のみ）。
- 変更: `abs|pdf|html` に広げる。
- テスト: `tests/arxiv-paper.test.ts` に `https://arxiv.org/html/2608.05435v1` を追加。

### T5. URL の掃除（automation）

- 対象: `src/utils/url.ts`。新規関数 `sanitizeArticleUrl(raw: string): string` を追加する。
  - `&amp;` を `&` に戻す。
  - 末尾の `>`、句読点、閉じ括弧を除去する（既存 `extractFirstUrl` の末尾除去と同じ集合に `>` を足す）。
  - URL の**末尾に連続する**非 ASCII 文字を除去する（`...nb266051df2bcグラフを` → `...nb266051df2bc`）。
    途中にある非 ASCII 文字（日本語パスなど）は触らない。
- 適用箇所（入口すべて）: `extractFirstUrl`、`utils/parseSlideArgs.ts` の `normalizeUrl`、
  `parseMangaSlackArgs.ts`、`parseVideoSlackArgs.ts`、`scripts/registerArticleFromDispatch.ts`。
  `shared/identity.ts` の `normalizeWebUrl` の前段で呼ぶ形にできるなら、そこ 1 か所に寄せてよい。
- テスト: `utils/url.test.ts` を追加。上の 3 例と、変化しないべき正常 URL を含める。

### T3. アクセス時の名乗りとタイムアウトを設定可能にする（automation）

- 対象: `src/config.ts` と `src/shared/sourceAggregator.ts` の `buildExtractorOptions`。
- 変更: 環境変数 `WEB_HTTP_USER_AGENT`（任意）と `WEB_HTTP_TIMEOUT_MS`（既定 30000）を追加し、
  `ExtractorOptions.http` に渡す。**content-extractor 側の既定値は変えない。**
- `.env.example` に 2 項目を追記する（エージェントから編集できない場合は、追記内容を報告に書く）。
- **決定済み（2026-11-15）**: 名乗りは一般的なブラウザのものに変える。
  - `WEB_HTTP_USER_AGENT` が未設定のときの既定値を、automation の `config.ts` に定数として持つ。
    値は、この PC に入っている Chrome の名乗りと同じ形式にする
    （`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<メジャー版>.0.0.0 Safari/537.36`）。
    `<メジャー版>` は実装時にインストール済み Chrome の版を確認して埋める。
  - content-extractor 側の既定値は変えない（bookmark-curator への影響を避けるため）。
  - 対象は automation 経由の取得だけ。アクセス頻度は現状（依頼 1 件につき 1 回、ページ送りは 500ms 間隔）から増やさない。

### T6. 取り込みの関門（automation）

- 対象: `src/shared/sourceAggregator.ts` の `fetchSourceContent`（URL 取得の全経路がここを通る）。
- 変更:
  1. `content.metadata.quality` を読み、`SourceContent`（`types/content.ts`）に `quality` を追加して返す。
  2. `verdict === "failed"`、または content-extractor が `ExtractionFailedError` を投げた場合、
     型付きエラー `SourceUnavailableError` を投げる。

     ```ts
     export class SourceUnavailableError extends Error {
       readonly name = "SourceUnavailableError";
       readonly url: string;
       readonly reason: string;   // "http_403" | "timeout" | "too_short" など
     }
     ```

     メッセージは利用者向けの文にする:
     `本文が取れていません（<理由の日本語>）。記事をコピーして、テキスト投入をお試しください。`
  3. `verdict === "partial"` は**生成を続ける**（既定）。`quality` を返すだけにする。
- 呼び出し側の対応（既存の `SessionExpiredError` と同じ形で `error.name` を見て分岐する）:
  - `domains/slides/slideJobProcessor.ts` の catch: `slidesStatus: "action_required"`、
    `statusMessage` にエラーメッセージ、診断コード `SOURCE_UNAVAILABLE`。Slack の失敗通知にも理由を含める。
  - `domains/manga/articleToManga.ts` の準備段階の catch: 同様。
  - `domains/video/videoPipeline.ts`: 現在の失敗時の状態書き込みを確認し、同じ扱いにする。
  - `scripts/readerRefresh.ts`、`workflows/urlToSlides.ts`: メッセージを表示して終了するだけでよい。
- 複数 URL（`fetchMultipleSourceContent`）: 挙動は変えない（1 本失敗で全体失敗）。
  エラーメッセージにどの URL が失敗したかが入っていることだけ確認する。
- 判定の保存: `upsertArticleSource` の第 3 引数に `quality`（`verdict` と `chars`）を追加し、
  `/articleSources/{articleId}` に保存する。Viewer 側の Rules は読み取りのみなので変更不要のはずだが、
  `multimodal-article-viewer/database.rules.json` と `tests/rules.contract.test.mjs` で確認すること。
- テスト: `shared/sourceAggregator.test.ts` に、`failed` で `SourceUnavailableError`、
  `partial` で続行、のケースを追加。`slideJobProcessor` は状態マッピングの単体テストを足す。

### T7. 計測スクリプト（automation）

- 新規 `src/scripts/extractionProbe.ts`（既存 `fetchSourceDebug.ts` を参考にする）。
  - 入力: URL を 1 行 1 件で書いたテキストファイル。
  - 出力: URL、判定、文字数、理由、エラー種別、所要時間を Markdown の表で標準出力に出す。
  - 生成処理（Codex 実行、Firebase 書き込み、Slack 通知）は一切行わない。
- `package.json` に `"extraction:probe": "tsx src/scripts/extractionProbe.ts"` を追加。
- `docs/extraction-probe-urls.txt` に検証用 URL（A・B・C 群）を置く。
- 実行と記録: 変更前（T1 のみ入れた状態）と変更後（全タスク完了時）の 2 回実行し、
  結果を `docs/extraction-probe-results.md` に貼る。
  変更後は「従来の名乗り（`WEB_HTTP_USER_AGENT` に従来値を明示して実行）」と「ブラウザの名乗り（既定）」の
  両方で測り、名乗りの変更だけでどのサイトが取れるようになったかが分かるようにする。

### T8. Viewer の表示（multimodal-article-viewer、別コミット）

- 対象: `app.js` の状態詳細パネル（`renderStatusDetailPanel` 付近）。
- 変更: 成果物が `action_required` で、説明文が「本文が取れていません」で始まる場合、
  パネルに「テキストで投入する」ボタンを出す。押すと既存の生成依頼パネルをテキストモードで開き、
  タイトル欄に記事タイトルを入れる（`openGenerationPanel` と `setGenerationMode` を使う）。
- 文字列の先頭一致に頼りたくない場合は、automation 側で成果物に `errorCode: "SOURCE_UNAVAILABLE"` を
  書き、それを見て分岐する。その場合は Rules と `tests/rules.contract.test.mjs` への影響を確認すること。
- テスト: `tests/viewer.spec.js` にフィクスチャで 1 ケース追加。既存 4 本が通ること。

## 6. コミットの区切り

1. content-extractor: T1（品質判定）
2. content-extractor: T2 + T4（エラーの受け止め、arXiv）→ `npm run build`
3. automation: T5（URL の掃除）
4. automation: T3（名乗りとタイムアウトの設定）
5. automation: T6（関門）
6. automation: T7（計測スクリプトと結果）
7. viewer: T8

各コミットの前に、そのリポジトリの `typecheck` と `test` を通すこと。push は行わず、人の確認を待つ。

## 7. 人が決めること（未決）

名乗りの変更は決定済み（T3 を参照）。残りは次の 3 点。

| 項目 | 既定（この計画での扱い） | 補足 |
|---|---|---|
| `partial` のときに生成するか | 生成する | 止めたい場合は T6 の 3 を「止める」に変える |
| 文字数のしきい値（200 / 500） | T1 の表のとおり | 結果を見て調整する |
| `titleMismatch` 検知の採否 | 採用。誤検知が出たら無効化 | T1 を参照 |

## 8. 報告に含めること

- 変更したファイルの一覧（リポジトリ別）。
- `docs/extraction-probe-results.md` の変更前後の表。
- 完了条件 1〜5 それぞれの達成状況。
- 計画どおりにできなかった点と、その理由。
