# manga-templates — NotebookLM 漫画化フロー用テンプレート資産

`article-to-slides-automation` の manga アウトライン生成（Step1/Step2）と、NotebookLM 投入（Step3）で使う、
記事ごとに変わらないテンプレート群を置くフォルダです。Codex CLI（`codex exec`）がここを読み込みます。

## フォルダ構成と配置するファイル（配置マニフェスト）

> 重要: 下記の **元ファイル（正しい UTF-8）をそのまま** 配置してください。
> ファイル名はコード側が参照するため、**先頭の記号（`01_` / `02_` / `画風A` 等）を変えない** こと。

```
manga-templates/
├─ prompts/
│   ├─ 01_ステップ1_原作分析と構成設計.txt   ← ステップ1プロンプト（コードは prompts/01_* を参照）
│   ├─ 02_ステップ2_ネーム詳細化.txt         ← ステップ2プロンプト（コードは prompts/02_* を参照）
│   ├─ 03_…（任意）                          ← Step3: NotebookLM Studio 生成指示。あれば upload/ に自動同梱
│   └─ 04_…（任意）                          ← Step4: 表紙生成プロンプト（任意）
├─ art-styles/
│   ├─ 画風A_王道少年漫画.txt                 ← --art-style A で参照（コードは art-styles/画風A* を参照）
│   ├─ 画風B_少女漫画.txt                     ← --art-style B
│   ├─ 画風C_4コマギャグ.txt                  ← --art-style C
│   ├─ 画風D_青年劇画.txt                     ← --art-style D
│   ├─ 画風E_アメコミ.txt                     ← --art-style E
│   ├─ 画風F_絵本風.txt                       ← --art-style F
│   └─ 画風G_レトロ昭和漫画.txt               ← --art-style G
└─ character-sheets/                          ← キャラクターシート画像（任意）。詳細は同フォルダ README
    └─ 例: 主人公キャラクター：田中太郎.png
```

## コードとの対応

- 画風選択: `--art-style A` → `art-styles/画風A*.txt` を前方一致で解決（接尾辞は自由）。
- Step1/Step2 の運用前提（NotebookLM 参照・ユーザーへの都度確認）は、ランナーが実行時に
  「下記<ソース本文>を読み替え対象とし、確認せず一度で全量出力する」よう **上書き** します。
  そのため **プロンプト原本は無加工のまま** 配置して構いません（コードが冒頭にヘッドレス用の枠を付与）。

## 未提供のファイル

- `03_*`（Step3 / NotebookLM Studio 生成指示）と `04_*`（Step4 / 表紙）は今回未提供です。
  - 無くても Step1/Step2 の生成は動作します（`upload/` には step1/step2 と選択画風のみが集約されます）。
  - Step3 プロンプトを配置すると、`upload/` に自動で同梱され、NotebookLM 投入が一括化されます。

## 配置の検証

配置後に以下で過不足を確認できます。

```
npm run manga:check
```
