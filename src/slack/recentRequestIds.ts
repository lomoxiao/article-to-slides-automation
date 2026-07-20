// Slack イベント再送に対する dedup 記憶。上限を超えたら挿入順で最古の ID から捨てる。
// (スライド用・マンガ用で同一実装が重複していたものを共通化)

export class RecentRequestIds {
  private readonly ids = new Set<string>();

  constructor(private readonly maxSize = 500) {}

  has(requestId: string): boolean {
    return this.ids.has(requestId);
  }

  remember(requestId: string): void {
    this.ids.add(requestId);

    if (this.ids.size <= this.maxSize) {
      return;
    }

    const oldest = this.ids.values().next().value as string | undefined;
    if (oldest) {
      this.ids.delete(oldest);
    }
  }
}
