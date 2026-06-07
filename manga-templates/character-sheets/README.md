# character-sheets — キャラクターシート画像の配置場所（任意）

漫画に登場する**繰り返しキャラ**の参照画像（PNG / JPG）をここに置きます。
`manga:outline` 実行時に、ここの画像が自動でジョブの `jobs/manga/[id]/character-sheets/` と
NotebookLM 投入用 `upload/` にコピーされ、ファイル名一覧が Step1 に渡されます。

## ルール

- 対応形式: `.png` / `.jpg` / `.jpeg` / `.webp`
- **ファイル名に「キャラクター」を含める**こと（NotebookLM がキャラ参照画像として認識するため）。
  - 例: `主人公キャラクター：田中太郎.png` / `ヒロインキャラクター：山田花子.png`
- ファイル名は Step1/Step3 がそのまま参照するため、**1文字も変えない**（生成後に改名しない）。
- 画像が無いキャラは英語タグ方式（`character_sheet: none`）で扱われます（配置は任意）。

## 記事ごとに切り替えたい場合

このフォルダは既定の入力先です。記事専用のフォルダを使う場合は実行時に指定します:

```
npm run manga:outline -- --url "https://..." --pages 8 --art-style A \
  --character-sheets path/to/this-article-characters
```

> このフォルダ直下に全キャラを混在させると毎回全件が投入されます。作品別に分けたい場合は
> `--character-sheets` で作品別フォルダを指定してください。
