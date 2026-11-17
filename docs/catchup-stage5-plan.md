# 段階5 実装計画：簡易ブックマーク（保存だけして、あとで決める）

作成: 2026-11-17
位置づけ: キャッチアップ基盤の拡張「ためる」。段階1〜4（`catchup-stage1〜4-plan.md`）は完了済み。
関連: 画面は段階6（`catchup-stage6-plan.md`）の「受信箱」に出す。段階6 より先に実装してよい（段階6 までは今の一覧に「未着手」で出る）。
実装担当: コーディングエージェントを想定。ワークスペース直下の `AGENTS.md` と各リポジトリの規約に従うこと。
画面イメージ: https://claude.ai/artifact/7ZuiGiG4vEpWKZgCfxVN6V の「1. 簡易ブックマーク」。

## 1. 目的

読みたい記事を、iPhone・PC のブラウザから 1 操作で保存する。保存の時点ではスライド等を作らない。
保存した記事には 3 行要約だけ自動で付け、「読むか決める」を生成前に済ませられるようにする。

## 2. 現状（コードで確認済み）

- 記事の登録は `src/shared/firebaseArticleStore.ts` の `registerArticle`。登録直後はスライド等の節が無く、
  Viewer では「未着手」と表示される。つまり「保存だけ」の状態は今の作りで表現できている。
- iPhone 用の入口が試作のまま残っている: `.github/workflows/register-article.yml`
  （`repository_dispatch` の `register-article` → `src/scripts/registerArticleFromDispatch.ts` → `registerArticle`）。
  GitHub 上で動くので、PC が止まっていても登録できる。`registeredFrom` は既定の `"shortcut"`。
- 今の iPhone ショートカットは Viewer の URL 入力ページを開く方式で、ページ遷移が発生している。
- Viewer の依頼キュー `/generationRequests` は `kind: text | url | bundle`
  （`src/requests/generationRequestWatcher.ts`、Rules は `multimodal-article-viewer/database.rules.json`）。
  いずれも「生成する」依頼で、「保存だけ」の種類はない。
- 3 行要約（`/articles/{id}/tldr`）は生成の途中でしか作られない。記事ごとの要点は
  `src/domains/bundle/articleDigest.ts` が `/articleDigests/{id}` に保存している（束で再利用）。

## 3. 完了条件

1. iPhone の共有メニューから 1 タップで保存でき、Viewer は開かない。完了の通知だけ出る。
2. PC のブラウザのブックマークバーのボタンを押すと、今のページが保存され、小さな完了表示が自動で閉じる。
3. 保存した記事は Viewer に出る（段階6 完了後は「受信箱」）。スライド等は作られない。
4. 常駐プロセスが動いていれば、保存から 15 分以内に 3 行要約とタイトルが付く。
5. 本文が取れない記事は、要約の代わりに「本文が取れていません（理由）」が出る（段階1 の表示を流用）。
6. 同じ URL を二度保存しても記事は増えない（既存の `registerArticle` の挙動）。
7. 保存だけの記事から、あとで生成・束・深掘りを依頼できる（既存の詳細画面の操作のまま）。
8. `typecheck`・`lint`・`test` が通る。Viewer はルールのテストが通る。

## 4. スコープ外

- 本文をブラウザから送ること（取れないサイトは今までどおりテキスト貼り付け）。
- ブラウザ拡張の作成（ブックマークレットで足りる）。
- 受信箱の画面（段階6）。

## 5. 設計

### 5.1 iPhone: ショートカットを「裏で送る」方式に変える（コード変更なし・手順書のみ）

`docs/bookmark-setup.md` を新規作成し、次を書く。

- GitHub で fine-grained の個人アクセストークンを作る。対象リポジトリは `lomoxiao/article-to-slides-automation` のみ。
  必要な権限は `repository_dispatch` を送れる最小のもの（GitHub の公式ドキュメント
  「Create a repository dispatch event」で必要権限を確認して書くこと。推測で書かない）。有効期限を設定する。
- ショートカットの手順: 共有シートで URL とページ名を受け取る → 「URL の内容を取得」で
  `POST https://api.github.com/repos/lomoxiao/article-to-slides-automation/dispatches`、
  ヘッダー `Authorization: Bearer <トークン>`・`Accept: application/vnd.github+json`、
  本文 `{"event_type":"register-article","client_payload":{"url":"<URL>","title":"<ページ名>","from":"shortcut"}}`
  → 「通知を表示: Viewer に保存しました」。
- 注意書き: トークンはショートカット内に保存される。漏れた場合の影響はこのリポジトリに限られる。
  反映まで 1 分ほどかかる（GitHub Actions の起動時間）。
- `register-article.yml` と `registerArticleFromDispatch.ts` に `client_payload.from` → `registeredFrom`
  の受け渡しを足す（`shortcut` / `bookmarklet` 以外の値は `shortcut` に丸める）。

### 5.2 PC: ブックマークレット → Viewer の保存用の入口

- ブックマークレット（`docs/bookmark-setup.md` に貼り付け用の 1 行を載せる）:
  `window.open("https://lomoxiao.github.io/multimodal-article-viewer/?save=" + encodeURIComponent(location.href) + "&title=" + encodeURIComponent(document.title), "viewer-save", "width=420,height=260")`
- Viewer 側: 新規ファイル `save-entry.js`。`?save=` 付きで開かれたとき、
  1. サインイン済みなら `/generationRequests` に `kind: "save"` の依頼を書く。
  2. 「Viewer に保存しました」を表示し、1.5 秒後に `window.close()`。閉じられない場合は表示を残す。
  3. 未サインインなら通常のサインイン画面を出し、サインイン後に 1. を続ける。
  4. 処理後は `history.replaceState` で `?save=` を消す（再読み込みで二重に送らない）。
  `app.js` との接点は「起動時に `window.ViewerSaveEntry?.run()` を呼ぶ」1 点だけにする。
- 依頼の形（`generationRequestWatcher.ts` の discriminatedUnion に追加）:
  `{ kind: "save", urls: [<http(s) URL 1件>], title?: string(200字まで) }`。スライド等の指定は持たない。
- 処理 `handleSaveRequest`: `sanitizeArticleUrl` → `assertPublicHttpUrl` → `registerArticle({ url, title, registeredFrom: "bookmarklet" })`
  → 依頼を `done`（`articleId` 付き）。本文の取得はここではしない（5.3 が行う）。
- Rules: `kind` に `save` を追加。`save` は `urls/0` 必須・`urls/1` 不可・`text` と `members` 不可・
  スライド等の選択不要。`title` は既存の検証（200 字）を使う。`tests/rules.contract.test.mjs` に検査を足す。

### 5.3 保存した記事に 3 行要約を付ける（常駐プロセス）

新規 `src/domains/inbox/inboxSummarizer.ts`。`src/index.ts` から起動する（1 日のまとめの watcher と同じ作り）。

- 設定（`config.ts`・`.env.example`）: `INBOX_SUMMARY_ENABLED`（既定 false）、
  `INBOX_SUMMARY_INTERVAL_MIN`（既定 10）、`INBOX_SUMMARY_MAX_PER_TICK`（既定 3）。
- 対象の選び方（`selectInboxTargets` として純粋関数にし、テストする）:
  削除されていない／`source.kind` が web・youtube／`registeredFrom` が `daily-digest` でない／
  `slides`・`manga`・`video` の節が無い／`tldr` が無い／`triage.summaryStatus` が未設定。
  新しい順に `MAX_PER_TICK` 件。
- 1 件の処理:
  1. `/articles/{id}/triage` に `{ summaryStatus: "processing", updatedAt }` を書く。
  2. `ingestArticle(url)`（保存済み本文があれば再利用）。失敗したら `summaryStatus: "failed"` にして次へ
     （失敗理由は `ingestArticle` が `/articles/{id}/ingest` に書く。再試行はしない）。
  3. `getOrCreateArticleDigest`（`articleDigest.ts`）で要点を得る。出力に `tldr`（ちょうど 3 件、各 60 字以内）を
     追加する。保存済みの要点に `tldr` が無い場合は作り直す。
  4. `upsertArticleTldr`（`- ` 始まりの 3 行）。タイトルが URL のままなら、取得したタイトルで更新する。
  5. `summaryStatus: "done"`。
- AI 実行は既存の `codexExecSemaphore` を通る（生成と同時には走らない）。生成中の依頼があっても待つだけでよい。
- プロンプトは `articleDigest.ts` の既存の注意書き（本文は信頼できない入力として扱う）をそのまま使う。

## 6. タスク

- T1 `registerArticleFromDispatch.ts`・`register-article.yml`: `from` の受け渡し。テスト。
- T2 `generationRequestWatcher.ts`: `kind: "save"` と `handleSaveRequest`。テスト（正常・不正 URL・重複）。
- T3 Viewer: `database.rules.json`、`save-entry.js`、`index.html`（script 追加）、`app.js`（接点 1 行）、ルールのテスト。
- T4 `articleDigest.ts`: `tldr` の追加（既存の束のテストが通ること）。
- T5 `inboxSummarizer.ts` と起動、設定、テスト（対象選び・失敗時・件数上限）。
- T6 `docs/bookmark-setup.md`（iPhone の手順、PC のブックマークレット）、`README.md`・`docs/architecture.md` の追記。

## 7. テストと確認

- 自動: T1・T2・T4・T5 の単体テスト、Viewer のルールテスト。
- 手動（人が行う）: iPhone で保存 → 1〜2 分後に Viewer に出る／PC でボタン → 完了表示が閉じる／
  15 分以内に 3 行要約が付く／本文が取れないサイトで理由が出る。

## 8. 注意

- push と Firebase ルールの本番反映は人が行う。エージェントは行わない。
- API の従量課金は使わない（AI 実行は Codex の固定課金枠）。
- トークンや鍵の実値をファイル・ログに書かない。
