/** Process-wide gate for CPU/memory intensive manga and video generation. */
class AsyncSemaphore {
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

export const resourceIntensiveSemaphore = new AsyncSemaphore();
