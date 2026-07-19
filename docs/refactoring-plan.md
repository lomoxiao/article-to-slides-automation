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

### A-2. ドメイン別のディレクトリ再編
- `services/` フラット構造を機能ドメインで分割する案:
  - `src/domains/slides/`（slideJobProcessor, gasSlides, googleSlides, chartRenderer, jobStore）
  - `src/domains/manga/`（articleToManga, mangaOutlineGen, mangaJobStore, mangaGenerationQueue, mangaDeckUrlFetcher）
  - `src/domains/notebooklm/`（notebookLmDriver, notebookLmPipeline, notebookLmSync）
  - `src/shared/`（runner 基盤, firebaseAdmin, googleAuth, driveUploader, slackNotifier, summarizer, textUtils）
- `types.ts` と `types/` の併存を解消し、型は各ドメイン配下または `shared/types` に一元化。
- 注意: 移動は import パス変更のみの機械的リファクタとして 1 コミットで行い、ロジック変更を混ぜない。
- 完了条件: `services/` 直下のファイル数が大幅減、`typecheck`/`test` 緑。

### A-3. 重複実装の統合
- ジョブストア: ID 生成・タイムスタンプ・job.json 読み書きを共通モジュールへ抽出。ディレクトリ遷移モデル（スライド: pending→processing→completed/failed）と固定フォルダモデル（マンガ）の差分は残してよい — 共通化するのは下回りのみ。
- CLI runner: `claudeRunner` / `codexRunner` の spawn + timeout + stdout/stderr ログ書き出し + 終了コード判定を共通 `cliRunner` に抽出。プロンプトの injection 対策文（codexRunner 内の Security constraints）も共通テンプレート化して claude 側にも適用。
- `.env` ローダー: `config.ts` の `loadDotEnv`/`applyEnvFile` を 1 箇所にし、`firebaseAdmin.ts` の重複実装を削除（または `dotenv` パッケージ採用を検討）。
- 完了条件: 重複ペアごとに共通モジュール 1 つ + 既存テスト緑 + 新規ユニットテスト。

### A-4. 大型ファイルの分割
- 優先順: `chartRenderer.ts`(624) → `notebookLmPipeline.ts`(567) → `slideJobProcessor.ts`(467) → `socketModeClient.ts`(437)。
- 分割方針: 「外部 I/O（Playwright 操作・API 呼び出し）」と「純粋ロジック（パース・整形・判定）」を分け、純粋ロジック側にテストを付ける。
- 完了条件: 各ファイル 300 行以下を目安、分離した純粋ロジックにテストあり。

### A-5. config の整理
- `config.ts` の 40 個超の env 変数をドメイン別（slack / codex / claude / google / notebooklm / manga / web-session）にグループ化した構造で export する。
- `z.coerce.boolean` の落とし穴（`"false"` が true になる。config 内コメントで既知）を `z.stringbool` 等の正しい boolean パースに置き換える。
- `.env.example` を実際の必須/任意区分と一致するよう更新。
- 完了条件: 呼び出し側が `config.slack.botToken` のようにグループ経由で参照。既存挙動維持をテストで担保。

### A-6. scripts/ の共通ブートストラップ
- `src/scripts/` 16 本の argv パース・エラーハンドリング・終了コードの流儀を統一する薄い共通ラッパを用意。
- 完了条件: 各スクリプトの定型部分がラッパ経由になり、usage 表示が統一される。

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

### B-3. 子プロセス実行の堅牢化
- `claudeRunner.ts:142` の `shell: true` は Windows の `.cmd` 解決都合。引数がシェル解釈される経路になるため、`spawn` に配列引数 + `shell: false` で `.cmd` をフルパス指定する方式へ変更できるか検証する（できない場合は引数のサニタイズを共通 runner に集約）。
- プロンプトへの untrusted テキスト混入対策（codexRunner の Security constraints 文）を共通 runner の必須機能にする（A-3 と同一作業）。
- 完了条件: spawn 呼び出しが共通 runner 経由のみになり、shell 解釈経路が排除または文書化される。

### B-4. 資格情報の取り扱い 🔶 移行中 (2026-07-20)
- 実施: config の既定パスを `~/.content-extractor/` 優先に変更（明示 env 設定が最優先、
  リポジトリ直下は移行期フォールバック+警告）。3ファイルを `~/.content-extractor/` へコピー済み。
  docs (google-oauth-setup / google-slides-setup) を新パスに更新。
- 残: .env の `GOOGLE_OAUTH_CREDENTIALS` / `GOOGLE_OAUTH_TOKEN` 行の削除（ユーザー作業）→
  動作確認 → リポジトリ直下の3ファイル削除。
- 残: OAuth スコープ / サービスアカウント権限の最小化レビュー、ログへの秘匿情報漏れ確認。
- 完了条件: リポジトリツリー内に秘密ファイルが存在しない。スコープ一覧が docs に明記される。

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
| 1 | セキュリティ即効: Slack 入口認証、入力検証、資格情報の外出し | B-1, B-2, B-4 | Phase 0 |
| 2 | 共通基盤抽出: runner 統合(+injection対策共通化)、ジョブストア下回り、.env ローダー | A-3, B-3 | Phase 0 |
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
