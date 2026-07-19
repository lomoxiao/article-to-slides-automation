// ジョブ ID は jobs/ 配下のディレクトリ名としてそのまま path.join されるため、
// 外部入力(Slack・argv)由来の ID によるパストラバーサルをここで遮断する。
// 現行の生成形式(20260429T080441Z-0f6e0c96)に加え、旧形式の人間命名 ID
// (2026-04-29-fujitsu-quantum-roundup 等)も通るよう、形式は固定せず
// 「使用文字の許可リスト」のみで判定する(ドット・区切り文字は一切許可しない)。
const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeJobId(jobId: string): boolean {
  return SAFE_JOB_ID_PATTERN.test(jobId);
}

export function assertSafeJobId(jobId: string): void {
  if (!isSafeJobId(jobId)) {
    throw new Error(`Invalid job id: ${JSON.stringify(jobId)}`);
  }
}
