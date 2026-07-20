// slideData 配列からのメタ情報抽出と TLDR 出力の整形(純粋ロジック)。

export function getSlideDataTitle(slideData: unknown[]): string | undefined {
  for (const slide of slideData) {
    const title = getStringProperty(slide, "title");
    if (title) {
      return title;
    }
  }
  return undefined;
}

export function getSlideDataHeadline(slideData: unknown[]): string | undefined {
  for (const slide of slideData) {
    const headline =
      getStringProperty(slide, "subhead") ??
      getStringProperty(slide, "subtitle") ??
      getStringProperty(slide, "notes");
    if (headline) {
      return truncateText(headline, 180);
    }
  }
  return undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.trim() ? property.trim() : undefined;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

/** codex の TLDR 出力を「- 」始まり3行以内の箇条書きへ正規化する(規則外の行は捨てる)。 */
export function normalizeTldr(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-・•]\s*/.test(line))
    .map((line) => `- ${line.replace(/^[-・•]\s*/, "")}`)
    .slice(0, 3)
    .join("\n");
}
