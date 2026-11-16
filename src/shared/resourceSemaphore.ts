/** 同時に1つだけ実行させるための順番待ち。待っている順に1件ずつ進める。 */
export class AsyncSemaphore {
  private active = false;
  private readonly waiters: Array<(release: () => void) => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.active) {
      this.active = true;
      return this.createRelease();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(this.createRelease());
      else this.active = false;
    };
  }
}

/** Process-wide gate for CPU/memory intensive manga and video generation. */
export const resourceIntensiveSemaphore = new AsyncSemaphore();

/**
 * AI CLI(codex / claude)の実行を、それぞれ同時に1本に制限する。
 * 同時に起動すると実行用フォルダ(.codex-runner-home)へのファイルコピーが衝突し(EBUSY)、
 * 固定課金枠の消費も重なるため。
 *
 * 取得順の約束: resourceIntensiveSemaphore を持った処理(漫画・動画)の中から AI を呼ぶのは可。
 * 逆(AI実行用を持ったまま resourceIntensiveSemaphore を取りに行く)は固まるので行わない。
 */
export const codexExecSemaphore = new AsyncSemaphore();
export const claudeExecSemaphore = new AsyncSemaphore();
