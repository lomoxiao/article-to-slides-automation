# リファクタリング観点計画

作成: 2026-07-20（コードベース調査に基づく）
目的: 保守メンテナンス性とセキュリティを高めるためのリファクタリングを、観点ごとに分割実行できる形で計画する。
スコープ: `article-to-slides-automation` 本体（スライド系・マンガ系・NotebookLM 系・GAS 系のサブワークフロー）。ワークスペース横断の共通化は最後に別枠で扱う。

## 現状サマリ（調査結果）

- `src/` 全体で約 8,400 行。サービス 37 ファイルに対しテストは 10 ファイル。
- ESLint 等の lint 設定なし（`typecheck` と `test` のみ）。
- サブドメインが 1 つの `services/` フラット構造に同居: スライド生成、マンガ生成、NotebookLM 自動操作、GAS 連携、Slack 入出力、Firebase/Drive 登録。
- 明確な重複ペア:
  - `jobStore.ts`（スライド）と `mangaJobStore.ts`（マンガ）— ジョブ ID 生成・job.json 読み書き・タイムスタンプ整形が重複
  - `claudeRunner.ts` と `codexRunner.ts` — spawn + タイムアウト + 入出力ログ書き出し + 結果パースの骨格が重複
  - `.env` ローダーが `config.ts` と `firebaseAdmin.ts` に二重実装
  - `types.ts` と `types/` ディレクトリが併存
- 大型ファイル: `chartRenderer.ts`(624行)、`notebookLmPipeline.ts`(567行)、`slideJobProcessor.ts`(467行)、`socketModeClient.ts`(437行)、`codexRunner.ts`(414行)
- セキュリティ状況:
  - 資格情報ファイル（`google-oauth-*.json`、`google-service-account.json`）はリポジトリ直下の平文だが gitignore 済み・未追跡（確認済み）
  - HTTP 経路の Slack ルート（`src/routes/slack.ts`）に署名検証なし。`SLACK_SIGNING_SECRET` は config に定義だけあり未使用。主経路は Socket Mode（`SLACK_APP_TOKEN` 設定時）
  - `job.json` の読み込みは `JSON.parse(...) as SlideJob` で無検証（zod スキーマ未適用）
  - `claudeRunner.ts` は Windows 都合で `shell: true` 起動
  - `codexRunner.ts` には prompt injection 対策文が既にあるが、runner 間で共通化されていない

---

## A. 保守性の観点

### A-1. 安全網の整備（他のすべてに先行）
- ESLint（typescript-eslint）導入。bookmark-curator が既に lint を持つので設定を揃える。
- CI（GitHub Actions）で `typecheck` + `test` + `lint` を回す。既存の `register-article.yml` とは別ジョブ。
- リファクタ対象に触る前に、その周辺の characterization test を足す（特に `jobStore`、`workflows/`、`parseSlideArgs` / `parseMangaSlackArgs`）。
- 完了条件: `npm run lint` が存在し、CI が main への push / PR で緑になる。

### A-2. ドメイン別のディレクトリ再編 ✅ 完了 (2026-07-20)
- 実施: `services/`(45ファイル)を機能ドメインへ機械的に移動(import パス書き換えのみ、
  ロジック変更なし、git は全件リネーム検出):
  - `src/domains/slides/`: slideJobProcessor, gasSlides, googleSlides, chartRenderer,
    jobStore, generationRequestWatcher
  - `src/domains/manga/`: articleToManga, mangaOutlineGen, mangaJobStore,
    mangaGenerationQueue, mangaDeckUrlFetcher
  - `src/domains/notebooklm/`: notebookLmDriver, notebookLmPipeline, notebookLmSync
  - `src/shared/`: runner 基盤(cliProcess/claudeRunner/codexRunner/codexConfig/promptGuards),
    firebaseAdmin, firebaseArticleStore, googleAuth, driveUploader, slackNotifier,
    summarizer, sourceAggregator, textUtils, identity, jobFiles,
    paginationDomainStore, sessionStatusStore
- 実施: `types.ts` を `types/content.ts` に統合(types/ へ一元化)。`services/` は消滅。

### A-3. 重複実装の統合 ✅ 完了 (2026-07-20)
- 実施: ジョブストア下回り(ID 生成・job.json 書き出し)を `services/jobFiles.ts` に抽出。
  ディレクトリ遷移モデル(スライド)と固定フォルダモデル(マンガ)の差分は各ストアに残置。
- 実施: spawn + timeout + プロセスツリー kill を `services/cliProcess.ts` に抽出し、
  claudeRunner / codexRunner の両方を載せ替え(公開 API・挙動は不変)。
- 実施: injection 対策文を `services/promptGuards.ts` に共通テンプレート化(codex 経路で使用)。
  claude -p 経路は --disallowedTools で全ツール禁止済みのため未適用
  (プロンプト変更は生成品質に影響し得るので適用は別途判断 — promptGuards.ts に明記)。
- 実施: `.env` ローダーを `utils/envFile.ts` に一本化(config.ts / firebaseAdmin.ts の重複解消)。
- テスト: cliProcess 6件 / envFile 3件を追加(計91件)。

### A-4. 大型ファイルの分割
- 優先順: `chartRenderer.ts`(624) → `notebookLmPipeline.ts`(567) → `slideJobProcessor.ts`(467) → `socketModeClient.ts`(437)。
- 分割方針: 「外部 I/O（Playwright 操作・API 呼び出し）」と「純粋ロジック（パース・整形・判定）」を分け、純粋ロジック側にテストを付ける。
- 完了条件: 各ファイル 300 行以下を目安、分離した純粋ロジックにテストあり。

### A-5. config の整理 ✅ 完了 (2026-07-20)
- 実施: env スキーマは flat のまま、export を9グループ(server/slack/codex/claude/summary/
  google/manga/notebookLm/web)に再構成。参照99箇所を機械的リネーム。
- 実施: `z.coerce.boolean` を明示語彙の `envBool` に置換("false"/"0" が正しく false になる。
  空文字の従来挙動は変数ごとに維持)。実 .env で boolean 6値の before/after 同一を確認済み。
- `.env.example` は権限設定によりエージェントから編集不可(必要なら手動更新)。

### A-6. scripts/ の共通ブートストラップ ✅ 完了 (2026-07-20)
- 実施: `scripts/lib/cli.ts` の usage() / fail()(メッセージのみ + exit 1)に統一。
  定型を持つ10本を変換(throw Error("Usage...") のスタックトレース表示を解消)。
- 意図的な明示 exit(0)(firebase/playwright がハンドルを保持するスクリプト)と、
  想定外エラーの Node 既定処理(スタック + exit 1)は従来どおり。

## B. セキュリティの観点

### B-1. Slack 入口の認証（最優先）✅ 完了 (2026-07-20)
- ユーザー決定: Socket Mode を唯一の経路とし、未使用の HTTP 経路は削除。
- 実施: `routes/slack.ts` 削除、`@fastify/formbody` 依存削除、未使用の
  `SLACK_SIGNING_SECRET` を config から削除、docs/architecture.md を実態に更新。
- 結果: 未認証で叩けるジョブ起動エンドポイントは存在しない（fastify に残るのは /health のみ）。

### B-2. 信頼境界での入力検証 ✅ 主要部完了 (2026-07-20)
- 実施: `job.json` 読み込みを zod スキーマ検証に変更（jobStore / mangaJobStore。未知キーは
  passthrough で前方互換維持）。実データ全474件で valid を確認済み。
- 実施: jobId のパストラバーサル対策（`utils/safeJobId.ts`。旧形式の人間命名 ID も通る
  許可リスト方式 `[A-Za-z0-9_-]{1,128}`)。ストア関数内をチョークポイントに。
- 残: Slack text → spawn 引数/プロンプト経路の網羅監査（A-3 の runner 共通化と同時に実施予定）。
- 挙動変更: 壊れた job.json は「黙って未発見扱い」ではなく明示エラーになる。

### B-3. 子プロセス実行の堅牢化 ✅ 完了 (2026-07-20)
- 実施: 全 spawn 呼び出しを `services/cliProcess.ts` の spawnCli / terminateProcessTree に集約。
- shell:true は claude(.cmd シム)経路のみ残存。Node は .cmd の shell:false 起動を
  CVE-2024-27980 対策で拒否するため排除不可 — 代わりに「引数は内部生成の単純トークンのみ、
  外部入力は必ず stdin 経由」という制約を cliProcess.ts に文書化した。
- injection 対策文の共通化は A-3 で実施済み(promptGuards.ts)。

### B-4. 資格情報の取り扱い ✅ 完了 (2026-07-20)
- 実施: config の既定パスを `~/.content-extractor/` 優先に変更（明示 env 設定が最優先、
  リポジトリ直下は移行期フォールバック+警告）。3ファイルを `~/.content-extractor/` へ移行し、
  .env 更新(ユーザー)・config の新パス解決確認・ハッシュ同一確認のうえリポジトリ直下の
  コピーを削除。docs (google-oauth-setup / google-slides-setup) も新パスに更新済み。
- 任意の追加課題(未実施): OAuth スコープ / サービスアカウント権限の最小化レビュー、
  ログへの秘匿情報漏れ確認 → Phase 4 の B-5/B-6 と合わせて実施可。

### B-5. Firebase ルールと管理系スクリプト
- `updateDatabaseRules.ts` は merge+backup 方式で安全側（維持）。ライブ Rules 自体のレビュー（デフォルト deny か、公開パスの範囲）を 1 回実施し、結果を docs に残す。
- Admin SDK はルールをバイパスするため、書き込みパスをストア層（`firebaseArticleStore` 等）に限定し、任意パス書き込みのユーティリティを作らない方針を明文化。
- 完了条件: Rules レビュー記録あり。Firebase 書き込みがストア層経由のみ。

### B-6. 依存関係の衛生
- `npm audit` を CI に追加（まず警告表示のみ、運用が回れば fail 化）。
- `playwright` / `sharp` / `firebase-admin` / `googleapis` のメジャー更新方針を決める（自動 PR は入れず、四半期ごと手動確認でも可）。
- 完了条件: audit が CI で可視化されている。

## C. ワークスペース横断（別枠・任意）

`firebaseAdmin.ts` 相当が homework-manga（`apps/worker/src/services/firebaseAdmin.ts`）に、Drive クライアントが bookmark-curator（`src/drive/client.ts`）にも重複している。`@local/content-extractor` と同じ file: 参照方式で `@local/google-clients`（firebaseAdmin + driveUploader + googleAuth）を切り出せば 3 パッケージの重複が消える。ただし各パッケージは独立 git リポジトリのため、リリース調整コストと相談。**A/B 完了後に着手判断。**

---

## 実行順序（フェーズ計画)

| Phase | 内容 | 観点 | 前提 |
|---|---|---|---|
| 0 | ✅ 完了 (2026-07-20): lint + CI + 周辺テスト追加 | A-1 | なし |
| 1 | ✅ 完了 (2026-07-20): Slack 入口認証、入力検証、資格情報の外出し | B-1, B-2, B-4 | Phase 0 |
| 2 | ✅ 完了 (2026-07-20): runner 統合(+injection対策共通化)、ジョブストア下回り、.env ローダー | A-3, B-3 | Phase 0 |
| 3 | 構造再編: ドメイン分割、大型ファイル分割、config 整理、scripts 統一 | A-2, A-4, A-5, A-6 | Phase 2 |
| 4 | 衛生・横断: audit CI、Rules レビュー、横断パッケージ化判断 | B-5, B-6, C | Phase 1-3 |

### Phase 0 実施メモ (2026-07-20)

- ESLint 10 + typescript-eslint 8 (flat config)。初回指摘9件は挙動を変えずに修正済み。
- CI (`.github/workflows/ci.yml`): `file:../content-extractor` は GitHub の
  lomoxiao/content-extractor を兄弟 checkout + build して再現。CI 緑を確認済み。
- テスト 74 件 (parseSlideArgs / parseMangaSlackArgs / jobStore の characterization 29件追加)。
- cwd 相対パス (`jobs/`) に触るテストは一時ディレクトリへ chdir する方式で隔離する。

## 実行時の原則

- 1 タスク = 1 観点。挙動を変えないリファクタとロジック変更を同一コミットに混ぜない。
- 各ステップで `npm run typecheck && npm test` を通す。Phase 0 以降は lint も。
- `jobs/` 配下は実データ（gitignore 済み）。ジョブストア変更時は既存 job.json との後方互換を保つ。
- 稼働中パイプライン（Slack→スライド、マンガ Phase1-4）を止めない。E2E 未検証項目（NotebookLM 本番 E2E 等）はリファクタの検証手段にしない。
- B-1 の経路選択（HTTP 廃止 or 署名検証）はユーザー決定が必要。着手前に確認する。
