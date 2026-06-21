export type MangaTreatment = "A" | "B" | "C";

export type MangaJob = {
  id: string;
  url: string;
  title?: string;
  pages: number;
  genre?: string;
  /** 画風パターン記号(A〜G)。manga-templates/art-styles/画風{X}*.txt を参照する。 */
  artStyle: string;
  /** 題材の扱い方: A=原作忠実 / B=脚色 / C=完全創作。 */
  treatment: MangaTreatment;
  audience?: string;
  focus?: string;
  requestedBy?: string;
  createdAt: string;
  updatedAt: string;
  jobDir: string;
  /** ジョブに取り込んだキャラクターシート画像のファイル名一覧(Step3 で NotebookLM に投入)。 */
  characterSheets?: string[];
  /** Step1 実行時の claude セッション ID(Step2 はこれを resume して継続する)。 */
  step1SessionId?: string;
  codexHomeDir?: string;
  step1OutputPath?: string;
  step2OutputPath?: string;
  /** NotebookLM 投入セットを集約したディレクトリ。 */
  uploadDir?: string;
  /** Drive にアップロードした step1/step2(Google ドキュメント)の webViewLink。 */
  driveFolderId?: string;
  driveStep1Url?: string;
  driveStep2Url?: string;
  /** Phase3: NotebookLM 自動操作(claude --chrome)の結果。executed=Step3実行 / skipped=Drive未完了等で非実行 / failed=失敗。 */
  notebookLmStatus?: "executed" | "skipped" | "failed";
  /** NotebookLM 操作の説明・失敗理由。 */
  notebookLmDetail?: string;
  /** Phase4: 生成スライドデックURL取得の結果。fetched=取得・登録成功 / pending=待機上限まで未完了 / failed=取得or登録失敗。 */
  mangaDeckStatus?: "fetched" | "pending" | "failed";
  /** 取得したスライドデックの共有URL(ベースURL)。 */
  mangaDeckUrl?: string;
  /** デックURL取得の説明・失敗理由。 */
  mangaDeckDetail?: string;
  error?: string;
};

export type CreateMangaJobInput = {
  url: string;
  title?: string;
  pages: number;
  genre?: string;
  artStyle: string;
  treatment: MangaTreatment;
  audience?: string;
  focus?: string;
  requestedBy?: string;
};
