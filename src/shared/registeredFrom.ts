/**
 * 記事がどこから登録されたか。外から渡される値(ショートカットやブックマークレットの申告)は、
 * 知っている値だけを通し、それ以外は既定の "shortcut" に丸める。
 */
const KNOWN_SAVE_ORIGINS = ["shortcut", "bookmarklet"] as const;
export type SaveOrigin = (typeof KNOWN_SAVE_ORIGINS)[number];

export function normalizeSaveOrigin(value: string | undefined | null): SaveOrigin {
  const candidate = (value ?? "").trim().toLowerCase();
  return (KNOWN_SAVE_ORIGINS as readonly string[]).includes(candidate) ? (candidate as SaveOrigin) : "shortcut";
}
