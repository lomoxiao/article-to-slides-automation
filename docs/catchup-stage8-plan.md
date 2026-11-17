# 段階8 実装計画：関心を Vault に還す（週 1 回の「関心まとめ」）

作成: 2026-11-17
位置づけ: キャッチアップ基盤の拡張「還す」。アプリ側の書き出しと、Vault 側の取り込み手順の 2 つに分かれる。
前提: 段階5（保存）・段階7（深掘り）があると材料が増える。無くても実装できる（ある材料だけ書き出す）。
実装担当: コーディングエージェントを想定。**Vault（`D:\work\brain`）の中はこの計画では書き換えない。**

## 1. 目的

何を保存し、何を生成し、何を深掘りしたか、という行動の記録を週 1 回ファイルにまとめる。
Vault 側の AI がそれを読み、「最近の関心」の更新候補を提案できるようにする。

## 2. Vault の規則（守ること）

- `BRAIN.md` の 1〜3 節と `roles/` は、人の承認なしに書き換えない。更新候補は `inbox.md` に
  `- [ ] [更新候補] <対象ファイル・節> / <提案内容> / <根拠>` の形で書く。
- 成果物の主張には証拠へのリンクか `[仮定]` を付ける。
- Vault の中で AI を自動起動しない（無人で成果物を作らせない）。
- ファイル・フォルダ・スキーマを増やす前に `EXTENSIONS.md` を見て、手順の無いものは人に聞く。

このため、アプリ側は **Vault の外** にファイルを置くだけにする。Vault に取り込むのは、人が AI を起動したときだけ。

## 3. 先に人が決めること（決まるまで該当箇所は実装しない）

1. 書き出し先のフォルダ（Vault の外）。設定 `INTEREST_EXPORT_DIR`。既定値は持たない。
2. Vault 側の受け皿（どのプロジェクトの evidence に置くか、新しいプロジェクトを起こすか）。
   これは Vault 側の判断なので、この計画では手順の案（6 章）だけ用意する。

## 4. 完了条件

1. `npm run interest:export -- [--week 2026-W47]` で、指定した週の「関心まとめ」が Markdown と JSON で出る。
2. 常駐プロセスが、週 1 回（既定: 日曜 21 時 JST）自動で書き出す。設定で止められる。
3. ファイルには記事の全文を含めない（タイトル・URL・日時・状態・3 行要約・観点まで）。
4. 書き出しは AI を使わない（集計だけ）。同じ週をもう一度書き出すと同じ内容で上書きされる。
5. Vault 側で使う取り込み手順（人が AI に渡す文面）が `docs/vault-feedback-prompt.md` にある。
6. `typecheck`・`lint`・`test` が通る。

## 5. アプリ側の設計（`article-to-slides-automation`）

### 5.1 材料（すべて Firebase から読むだけ）

- `/articles`: 登録日時、`registeredFrom`、種別、タイトル、URL、`tldr`、スライド・漫画・動画・音声の状態、
  束（`bundle.members`）、深掘り（`research.baseArticleId`・`aspects`・`note`・`vaultCandidate`）、削除の有無。
- `/readState/{uid}`: 既読・あとで（利用者は 1 人。複数あれば新しい更新を採る。
  news-dashboard の `src/interest/collector.ts` と同じ考え方）。

### 5.2 出力（`src/domains/interest/interestExport.ts`。集計は純粋関数にしてテストする）

`<INTEREST_EXPORT_DIR>/interest-<ISO週>.md` と `.json`。Markdown の構成:

1. 期間と件数（保存／生成した／束／深掘り／既読／あとで／読まずに削除）
2. **深掘りした記事**（最も強い関心の印）: 元記事、観点、自由記入、レポートの 3 行要約。「Vault への候補」の印つきを先に。
3. **束にした記事**: 束のタイトルと中の記事。
4. **生成した記事**: 何を作ったか（スライド／漫画／動画）。
5. **保存しただけの記事**: タイトルと URL。
6. **読まずに削除した記事**（関心が弱い印）: タイトルのみ。
7. 出どころ別の件数（ドメイン上位 10）。

各行に記事の ID と URL を付ける（Vault 側で証拠として引けるように）。解釈・要約・推測は書かない。

### 5.3 実行

- スクリプト `src/scripts/exportInterest.ts`（`package.json` に `interest:export`）。
- 自動実行 `startInterestExportWatcher`（`src/index.ts`）。設定: `INTEREST_EXPORT_ENABLED`（既定 false）、
  `INTEREST_EXPORT_DIR`、`INTEREST_EXPORT_DAY`（既定 0 = 日曜）、`INTEREST_EXPORT_HOUR_JST`（既定 21）。
  `INTEREST_EXPORT_DIR` が未設定なら起動せず、ログに 1 行出す。
- 書き出し先が Vault の中（パスに Vault のルートを含む）だった場合は拒否する（設定 `VAULT_ROOT` と比較）。

## 6. Vault 側の手順の案（`docs/vault-feedback-prompt.md` に置く。Vault へはコピーしない）

人が Vault で Claude Code / Codex を開いたときに貼る文面。内容:

- 読むファイル（`INTEREST_EXPORT_DIR` の最新の `interest-*.md`）と、Vault の再開手順（`CLAUDE.md`）に従うこと。
- やること: (1) ファイルを証拠として所定の場所に写す（場所は 3 章 2 で決めたもの。未決なら `questions.md` に書いて止まる）
  (2) 過去の週と比べて、増えた関心・減った関心・新しく現れた話題を挙げる（各項目に証拠へのリンク）
  (3) `BRAIN.md` の関心に関わる記述の更新候補を `inbox.md` に規定の形で書く
  (4) 深掘りで「Vault への候補」の印が付いたものを、どのプロジェクトの材料にできるか提案する。
- やらないこと: `BRAIN.md` 1〜3 節と `roles/` の直接変更、新しいフォルダやスキーマの追加、外部への送信。

## 7. タスク

- T1 `interestExport.ts`（集計と Markdown / JSON の組み立て）とテスト（週の境界、削除済み、材料が無い週）。
- T2 `exportInterest.ts` と `package.json`。
- T3 自動実行と設定、Vault 内への書き出し拒否、テスト。
- T4 `docs/vault-feedback-prompt.md`、`README.md`・`docs/architecture.md`・`.env.example`。

## 8. 確認（人が行う）

- 1 週分を書き出して読み、関心の記録として違和感がないか。載せたくない項目がないか。
- Vault で手順の文面を使い、`inbox.md` に候補が規定の形で入るか。

## 9. 注意

- 実 `.env` は本人が管理する。エージェントは内容を読まない・表示しない。
- この段階では AI からの提案（束や深掘りのおすすめ）は作らない。材料がたまってから別の計画にする。
