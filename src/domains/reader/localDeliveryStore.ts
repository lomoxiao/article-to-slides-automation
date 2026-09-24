import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

// Firebase を持たない経路（CLI 単体実行）向けの送信状態ストア。
// 資格情報と本文は保存しない。保存するのは送信済み判定に必要な最小限だけ。

export type LocalDeliveryRecord = {
  status: "processing" | "completed" | "failed";
  contentHash: string;
  bookmarkId?: string;
  target?: string;
  errorCode?: string;
  updatedAt: string;
};

export type ReadingDeliveryStore = {
  get(key: string): Promise<LocalDeliveryRecord | undefined>;
  put(key: string, record: Omit<LocalDeliveryRecord, "updatedAt">): Promise<void>;
};

export const DEFAULT_DELIVERY_STORE_PATH = ".state/instapaper-deliveries.json";

export function createLocalDeliveryStore(
  filePath: string = DEFAULT_DELIVERY_STORE_PATH,
  now: () => Date = () => new Date()
): ReadingDeliveryStore {
  const absolute = resolve(filePath);

  const readAll = async (): Promise<Record<string, LocalDeliveryRecord>> => {
    try {
      const raw = await readFile(absolute, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as Record<string, LocalDeliveryRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      // 壊れたストアで送信を止めない。未送信扱いにして次の書き込みで作り直す。
      if (error instanceof SyntaxError) return {};
      throw error;
    }
  };

  return {
    async get(key) {
      const all = await readAll();
      return all[hashKey(key)];
    },
    async put(key, record) {
      const all = await readAll();
      all[hashKey(key)] = { ...record, updatedAt: now().toISOString() };
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    }
  };
}

/** ローカルの絶対パスがそのまま残らないよう、キーはハッシュ化して保存する。 */
export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

export function createMemoryDeliveryStore(
  now: () => Date = () => new Date()
): ReadingDeliveryStore & { snapshot(): Record<string, LocalDeliveryRecord> } {
  const records: Record<string, LocalDeliveryRecord> = {};
  return {
    async get(key) {
      return records[hashKey(key)];
    },
    async put(key, record) {
      records[hashKey(key)] = { ...record, updatedAt: now().toISOString() };
    },
    snapshot() {
      return { ...records };
    }
  };
}
