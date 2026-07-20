// スクリプト共通の CLI 定型: usage / エラー表示と終了コードの統一。
// - usage / fail はメッセージのみを stderr に出して exit(1) する(スタックトレース無し)
// - 想定外の例外は各スクリプトで握りつぶさず Node 既定(スタックトレース + exit 1)に任せる
// - 正常系で明示 exit(0) が要るのは firebase-admin / playwright 等が
//   ハンドルを保持するスクリプトのみ(各スクリプト側の責務)

/** 使い方エラー: usage をそのまま stderr へ表示して exit(1)。 */
export function usage(message: string): never {
  console.error(message);
  process.exit(1);
}

/** 実行時失敗: 原因が明確でスタック不要な失敗をメッセージのみで exit(1)。 */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
