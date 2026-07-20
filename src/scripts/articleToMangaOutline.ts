import { parseMangaArgs } from "../utils/parseMangaArgs.js";
import { runArticleToMangaJob } from "../domains/manga/articleToManga.js";
import { runNotebookLmDeckRetrieval } from "../domains/notebooklm/notebookLmPipeline.js";
import { fail, usage } from "./lib/cli.js";

const parsed = parseMangaArgs(process.argv.slice(2));
if (!parsed.ok) {
  usage(
    `引数エラー: ${parsed.errorMessage}\n` +
      'Usage: npm run manga:outline -- --url "https://..." --pages 8 [--genre 教育・解説] [--art-style A] [--treatment B]'
  );
}

try {
  const result = await runArticleToMangaJob({
    url: parsed.url,
    pages: parsed.pages,
    genre: parsed.genre,
    artStyle: parsed.artStyle,
    treatment: parsed.treatment,
    audience: parsed.audience,
    focus: parsed.focus,
    characterSheetsDir: parsed.characterSheetsDir,
    logger: (message) => console.log(message)
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        jobId: result.job.id,
        jobDir: result.job.jobDir,
        artStyle: result.artStyleName,
        characterSheets: result.characterSheets,
        step1OutputPath: result.step1OutputPath,
        step2OutputPath: result.step2OutputPath,
        uploadDir: result.uploadDir,
        driveStep1Url: result.driveStep1Url,
        driveStep2Url: result.driveStep2Url,
        notebookLmStatus: result.notebookLmStatus,
        notebookLmDetail: result.notebookLmDetail
      },
      null,
      2
    )
  );

  if (result.notebookLmStatus === "executed") {
    console.log("\nNotebookLM: ソースを同期し Step3(漫画生成)を実行しました。");
  } else if (result.notebookLmStatus === "skipped") {
    console.log("\nNotebookLM: 同期対象がなかったため Step3 はスキップしました(ソース未更新)。");
  } else if (result.notebookLmStatus === "failed") {
    console.log(`\nNotebookLM 連携に失敗しました(手動で確認してください): ${result.notebookLmDetail ?? "原因不明"}`);
  } else {
    console.log("\n次の手順: upload/ のファイルを NotebookLM にアップロードして Step3(スライドブック生成)を実行してください。");
  }

  // 後続フェーズ: Step3 起動済みなら生成完了を待ってデックURLを取得し Firebase 登録 + Slack 通知。
  // MANGA_DECK_AUTOFETCH 未設定なら内部で即 return する。
  await runNotebookLmDeckRetrieval({
    job: result.job,
    notebookLmStatus: result.notebookLmStatus,
    requestedBy: undefined,
    logger: (message) => console.log(message)
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`生成に失敗しました: ${message}`);
}
