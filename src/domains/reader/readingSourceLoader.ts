import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import {
  normalizeReadingMarkdown,
  parseMarkdownDocument,
  type ReadingSource,
  type ReadingSourceOrigin
} from "./readingSource.js";

export type LoadReadingSourceInput = {
  origin: ReadingSourceOrigin;
  /** file / vault-artifact のとき必須。 */
  path?: string;
  /** stdin / inline のとき必須。 */
  text?: string;
  /** 明示タイトル。省略時は frontmatter → 見出し → ファイル名の順に決める。 */
  title?: string;
  sourceUrl?: string;
  tldr?: string;
  /** 冪等キーの明示指定。省略時は path、それも無ければ内容から導く。 */
  key?: string;
  now?: () => Date;
};

export class ReadingSourcePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadingSourcePolicyError";
  }
}

/**
 * Vault の成果物として送ってよいのは artifacts/ 配下だけ。
 * evidence/ は調査の一次記録であり、外部送信の承認範囲に含まれていない。
 */
export function assertVaultArtifactPath(path: string): void {
  const segments = resolve(path).split(sep);
  if (!segments.includes("artifacts")) {
    throw new ReadingSourcePolicyError(
      `Vault から送れるのは artifacts/ 配下の成果物だけです: ${path}`
    );
  }
  if (segments.includes("evidence")) {
    throw new ReadingSourcePolicyError(`evidence/ は外部送信の対象外です: ${path}`);
  }
}

export async function loadReadingSource(
  input: LoadReadingSourceInput,
  readFileImpl: typeof readFile = readFile
): Promise<ReadingSource> {
  const now = input.now ?? (() => new Date());

  let raw: string;
  let fallbackTitle: string | undefined;
  let key: string | undefined = input.key;

  if (input.origin === "vault-artifact" || input.origin === "markdown-file") {
    if (!input.path) throw new Error(`${input.origin} requires a file path`);
    if (input.origin === "vault-artifact") assertVaultArtifactPath(input.path);
    const absolute = isAbsolute(input.path) ? input.path : resolve(input.path);
    raw = await readFileImpl(absolute, "utf8");
    fallbackTitle = basename(absolute).replace(/\.mdx?$/i, "");
    key ??= normalizeKey(absolute);
  } else {
    if (!input.text || !input.text.trim()) throw new Error(`${input.origin} requires text`);
    raw = input.text;
    key ??= undefined;
  }

  const parsed = parseMarkdownDocument(raw);
  const title =
    input.title?.trim() ||
    parsed.frontmatter.title ||
    parsed.title ||
    fallbackTitle ||
    "保存済みメモ";
  const markdown = normalizeReadingMarkdown(parsed.body);
  if (!markdown) throw new Error("Reading source has no body text");

  return {
    key: key ?? `${input.origin}:${title}`,
    title,
    markdown,
    tldr: input.tldr,
    sourceUrl: input.sourceUrl,
    capturedAt: now().toISOString(),
    origin: input.origin,
    richText: true
  };
}

function normalizeKey(absolutePath: string): string {
  return absolutePath.split(sep).join("/");
}
