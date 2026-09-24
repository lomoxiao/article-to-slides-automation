# 任意の読み物を Instapaper 経由で Kobo へ送る

`docs/instapaper-kobo-phase0.md` で確立した Instapaper 連携を、Web 記事以外の入力にも使えるようにした経路です。
Kobo は Pocket 終了後に Instapaper を正式サポートしているため、Instapaper に入れば Kobo の Home に同期されます。

## 既存経路との関係

**既存の `reader:refresh` 経路は一切変更していません。** Web 記事 → Firebase → Reader URL + content の流れはそのままです。

| | 既存 `reader:refresh` | 新規 `instapaper:send` |
| --- | --- | --- |
| 入力 | Web 記事の URL | Vault の成果物 / 任意の Markdown / 標準入力 |
| 本文の保存先 | Firebase | 保存しない |
| 送信状態 | Firebase `/instapaperDeliveries` | ローカル JSON `.state/instapaper-deliveries.json` |
| 送信方式 | URL + content | `--url` があれば URL + content、無ければ Private Source |
| 共有している実装 | `instapaperClient.ts`, `readingEdition.ts` | 同左 |

`readingEdition.ts` には表とインライン記法の対応を足しましたが、**`features.richText` を渡したときだけ有効**です。
既存の呼び出しは `features` を渡さないため、出力 HTML は 1 バイトも変わりません（`readingEdition.test.ts` の
"leaves tables and inline markup untouched unless richText is enabled" で固定しています）。

## 使い方

モード（`preview` / `send`）は必須です。`preview` は外部状態を一切変えません。送信状態のストアにも触りません。

```powershell
# Vault の成果物を下見する
npm run instapaper:send -- preview --vault-artifact D:/work/brain/projects/payments-weekly/artifacts/2026-09-05-2026-09-11-weekly-report.md

# 送信する
npm run instapaper:send -- send --vault-artifact D:/work/brain/projects/payments-weekly/artifacts/2026-09-05-2026-09-11-weekly-report.md

# 任意の Markdown ファイル
npm run instapaper:send -- send --file D:/tmp/research-notes.md --title "GPT-6 Astra の評判"

# 標準入力（会話でまとめた内容をそのまま流す）
Get-Content notes.md | npm run instapaper:send -- send --stdin --title "調査メモ" --key "chat:2026-09-12-astra"

# 元記事 URL がある場合は従来の URL + content 方式になる
npm run instapaper:send -- send --file notes.md --url https://example.com/article
```

## 入力の種類

| 指定 | 用途 | タイトルの決まり方 |
| --- | --- | --- |
| `--vault-artifact <path>` | Vault の成果物 | frontmatter `title` → 最初の `#` 見出し → ファイル名 |
| `--file <path>` | 任意の Markdown | 同上 |
| `--stdin` | 会話の出力などを直接 | `--title` 推奨。無い場合は「保存済みメモ」 |

`--vault-artifact` だけはポリシーが効きます。**`artifacts/` 配下以外と `evidence/` 配下は拒否します。**
Vault の成果物のうち外部送信が承認されているのは `artifacts/` の成果物だけであるためです
（→ brain Vault の `decisions/2026-09-12-payments-weekly-kobo-delivery.md`）。
`--file` にはこのポリシーは適用しません。用途を限定しないための入口です。

## Markdown の扱い

- YAML frontmatter は切り離し、`title` があればタイトルに使う
- 最初の `#` 見出しをタイトルへ引き上げ、本文からは外す（二重表示を避ける）
- Obsidian の `[[wikilink]]` は `（出典: <末尾のセグメント>）` に変換する。Kobo からはリンク先へ飛べないため、出典が読み取れる文字列だけを残す
- 表は**行ごとの入れ子の箇条書き**で送る（`tableLayout: "list"`）。先頭列を行の見出し、残りの列を「列名: 値」の子項目にし、先頭列が `#` なら「1. 見出し」の形にする。
  Instapaper のパーサが `table` `tbody` `tr` `td` を除去し `thead` `th` だけ残すため、`<table>` で送るとセルの文字が区切り無しで連結される（2026-09-13、bookmarks/get_text で確認）。`<table>` 描画自体は `readingEdition.ts` に残しており、`tableLayout` を渡さなければ従来どおり表になる
- `**太字**`、`` `コード` ``、`[text](url)` を解釈する。リンクは http/https 以外を落とす

## 重複送信の防止

`.state/instapaper-deliveries.json` に「冪等キー → 内容ハッシュ」を記録し、内容が同じ再実行は送信をスキップします。
保存日時だけが変わった再実行は同一内容として扱います。

**Private Source 方式は URL を持たないため、Instapaper 側で同一記事の判定ができません。**
このローカル記録が唯一の重複防止手段です。ストアを消すと次回は新しいブックマークとして送られます。

キーは SHA-256 でハッシュ化して保存するため、ローカルの絶対パスがそのままファイルに残ることはありません。
本文と資格情報は保存しません。

## 前提

`.env` に 4 つの資格情報が要ります。取得手順は `docs/instapaper-kobo-phase0.md` の「1. Consumer token」「2. Access token」と同じです。

```dotenv
INSTAPAPER_CONSUMER_KEY=...
INSTAPAPER_CONSUMER_SECRET=...
INSTAPAPER_ACCESS_TOKEN=...
INSTAPAPER_ACCESS_TOKEN_SECRET=...
```

4 つのうち 1 つでも欠けている場合、`send` は何もせずに終了します。
