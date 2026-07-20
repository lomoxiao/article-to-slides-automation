import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

// NotebookLM は固定ノートブック+固定 Drive ドキュメントのシングルトン資源のため、
// mkdir ベースのプロセス間ロックで直列性を保証する(daemon と manga:resume の排他)。
// 親ディレクトリ jobs/manga/ はジョブ作成時に必ず存在する前提(テストでは自前で用意する)。

const LOCK_DIR = path.join("jobs", "manga", ".nblm.lock");
const LOCK_STALE_MS = 60 * 60 * 1000;

export async function acquireNblmLock(): Promise<{ ok: true } | { ok: false; detail: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(LOCK_DIR);
      return { ok: true };
    } catch {
      const stale = await isLockStale();
      if (stale) {
        await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      return {
        ok: false,
        detail:
          "別の NotebookLM 操作が実行中のためスキップしました(.nblm.lock)。" +
          "daemon のジョブ完了後に npm run manga:resume で再開してください"
      };
    }
  }
  return { ok: false, detail: "NotebookLM ロックの取得に失敗しました(.nblm.lock)" };
}

async function isLockStale(): Promise<boolean> {
  try {
    const info = await stat(LOCK_DIR);
    return Date.now() - info.mtimeMs > LOCK_STALE_MS;
  } catch {
    // stat できない = 直前に解放された。取得を再試行してよい。
    return true;
  }
}

export async function releaseNblmLock(): Promise<void> {
  await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
}
