# 段階6 実装計画：画面下のタブで切り替える（受信箱／記事一覧／定期購読／深掘り）

作成: 2026-11-17
位置づけ: キャッチアップ基盤の拡張「読むか決める」。対象は `multimodal-article-viewer` のみ。
前提: 段階5（`catchup-stage5-plan.md`）があると受信箱に 3 行要約が出る。無くても実装できる。
実装担当: コーディングエージェントを想定。
画面イメージ: https://claude.ai/artifact/7ZuiGiG4vEpWKZgCfxVN6V の「5. 状態での表示切り替え」。

## 1. 目的

保存しただけの記事と、何かを生成した記事を分けて見られるようにする。
切り替えは iPhone で親指が届く画面下のタブで行う。今の記事一覧の作り（絞り込み・スワイプ・詳細）は変えない。

## 2. 決定事項（利用者の指示）

- タブは 4 つ: **受信箱／記事一覧／定期購読／深掘り**。画面の下に固定する。
- **受信箱**: 生成前の、保存だけの記事。
- **記事一覧**: スライド・漫画・動画など何かを生成した記事。今の一覧の方針のまま。
- **定期購読**: 毎朝の「1 日のまとめ」。
- **深掘り**: 深掘りレポート（段階7）。

## 3. 現状（コードで確認済み）

- 一覧は `app.js` の `renderList` と `getFilteredArticles`。絞り込みは種別と既読（`#filterPanel`）。
- 記事の正規化は `normalizeArticle`。`isDigest`（`registeredFrom === "daily-digest"`）、
  `source.kind`（web / youtube / text / bundle）、`slides`・`manga`・`video` の `exists` を持つ。
- 画面下には既に 3 つの固定部品がある: 右下のボタン（`.floating-actions`、＋と検索）、
  音声プレーヤー（`.audio-player-bar`）、束の選択バー（`.bundle-select-bar`）。
- スマホでは詳細・Reader・スライド表示中に `body.sheet-open` などが付き、裏の一覧は動かない。
- 新機能は別ファイルに置き、`app.js` は接点だけにする方針（`audio-player.js`・`bundle-select.js` と同じ）。

## 4. 完了条件

1. 画面下に 4 つのタブが常に出て、1 タップで切り替わる。選んだタブは次に開いたときも保たれる。
2. どの記事もちょうど 1 つのタブに属する（5.1 の規則）。
3. 受信箱の行に、3 行要約と「生成する」「深掘り」「削除」が出る。
4. 受信箱のタブに件数、定期購読と深掘りのタブに未読の件数が出る。
5. 右下のボタン・音声プレーヤー・束の選択バーが、タブと重ならない。
6. 詳細シート・Reader・スライド表示・生成パネルを開いている間、タブは隠れる（スマホ幅）。
7. 記事一覧タブの中で、今の絞り込み・スワイプ・束の選択がそのまま使える。
8. 既存のテストが通り、追加したテストが通る。

## 5. 設計

### 5.1 どのタブに属するか（`shelfOf(article)`。純粋関数）

上から順に判定し、最初に当たったものにする。

1. `isDigest` → `subscription`（定期購読）
2. `source.kind === "research"` → `research`（深掘り。段階7 で追加される種別）
3. `source.kind === "bundle"` → `list`（束は記事一覧）
4. `slides`・`manga`・`video` のどれかが `exists` → `list`
5. それ以外 → `inbox`（受信箱）

生成を依頼した直後は節が `processing` で作られるので、その時点で記事一覧へ移る。

### 5.2 部品 `shelf-nav.js`（新規）

- `window.ShelfNav = { init, shelfOf, current, counts }`。
- `init({ mount, onChange, getArticles, readStateOf })`: 画面下に `<nav aria-label="表示の切り替え">` を作り、
  4 つの `<button>`（`aria-current="page"` で選択中を示す）を置く。選択は `localStorage`（try/catch 付き）に保存する。
- アイコンは線画の SVG を部品内に持つ（絵文字は使わない）。ラベルは常に表示する。
  - 受信箱: トレー（下が開いた箱に書類が入る形）
  - 記事一覧: 重ねたカード（横線 3 本の入った角丸の四角）
  - 定期購読: カレンダー（上に 2 つの留め具、中に点）
  - 深掘り: 虫眼鏡に＋
- バッジ: 受信箱は件数、定期購読・深掘りは未読件数。0 のときは出さない。99 を超えたら「99+」。
- タップ領域は高さ 56px 以上。下端に `env(safe-area-inset-bottom)` を足す。

### 5.3 `app.js` の接点（最小限）

- `getFilteredArticles` の先頭に 1 行: `ShelfNav.shelfOf(article) !== ShelfNav.current()` なら除外。
- 起動時に `ShelfNav.init(...)`。`onChange` で `renderList()`。記事データが更新されたらバッジを更新する。
- `renderList` の行の組み立て: 受信箱のときだけ行の中身を差し替える関数
  `renderInboxRow(article)` を呼ぶ（新規ファイル `inbox-row.js` に置く）。
  - 表示: 種別、保存した日、タイトル、3 行要約（無ければ「要約を作成中」、`ingest.verdict === "failed"` なら理由）。
  - ボタン: 「生成する」（既存の `openGenerationPanel` を、その記事を対象に開く）／
    「深掘り」（段階7 の `ResearchAsk.open(article)`。未実装の間は出さない）／
    「削除」（既存の `deleteArticle`。編集権限があるときだけ）。
  - 行のタップは今までどおり詳細を開く。スワイプ操作も残す。
- 種別の絞り込み（Web / YouTube / 束）は記事一覧タブでだけ出す。他のタブでは `#filterPanel` の種別を隠す。

### 5.4 画面下の部品の重なり（`styles.css`）

タブの高さを CSS 変数 `--shelf-nav-h`（56px + safe-area）にし、次を調整する。

- `.floating-actions`・`.audio-player-bar`・`.bundle-select-bar`・`.bottom-search-bar` の `bottom` に `var(--shelf-nav-h)` を足す。
- `.library-pane` の下の余白に `var(--shelf-nav-h)` を足す（最後の行が隠れないように）。
- スマホ幅で `body.sheet-open`・`body.slides-viewer-open`・`body.generation-panel-open` のときはタブを `display: none`、
  上記の `bottom` の加算も外す。
- 768px 以上: タブは一覧のある左の列の下端に、その列の幅で置く（右の詳細の列には被せない）。

### 5.5 空の表示

- 受信箱が空: 「保存した記事はここに入ります」＋保存方法への一言（共有メニュー／ブックマークバー）。
- 深掘りが空: 「記事の『深掘り』から依頼できます」。

## 6. タスク

- T1 `shelf-nav.js`（`shelfOf`・バッジ・保存・アイコン）と `styles.css`。
- T2 `inbox-row.js` と `app.js` の接点。
- T3 重なりの調整（5.4）。スマホ幅・768px 以上の両方。
- T4 テスト: `tests/rules.contract.test.mjs` に構成の検査（script の読み込み順、`shelfOf` の規則を Node で直接実行）、
  Playwright に `tests/shelf-nav.spec.js`（切り替え・バッジ・重ならないこと・シート表示中に隠れること）。
- T5 `README.md` の画面説明を更新。

## 7. 確認（人が行う）

- iPhone 実機: 親指でタブが押しやすいか／右下のボタンや音声プレーヤーと重ならないか／一覧が最後までスクロールできるか。
- push 後は古い部品が混ざることがあるので、10 分ほど置いて開き直す。

## 8. 注意

- `app.js` を大きく書き換えない。接点以外は新規ファイルに置く。
- push は人が行う。Firebase ルールの変更はこの段階には無い。
