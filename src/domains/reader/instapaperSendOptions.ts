import type { ReadingSourceOrigin } from "./readingSource.js";

// 既存の reader:refresh と同じく、モード指定を必須にして
// 「うっかり外部状態を変える」事故を防ぐ。

export type InstapaperSendOptions = {
  mode: "preview" | "send";
  origin: ReadingSourceOrigin;
  path?: string;
  title?: string;
  tldr?: string;
  sourceUrl?: string;
  key?: string;
  storePath?: string;
  privateSourceName?: string;
};

export const INSTAPAPER_SEND_USAGE = [
  "Usage: npm run instapaper:send -- <preview|send> <source> [options]",
  "",
  "Source (choose one):",
  "  --vault-artifact <path>  Vault の artifacts/ 配下の成果物を送る",
  "  --file <path>            任意の Markdown ファイルを送る",
  "  --stdin                  標準入力の Markdown を送る（--title 推奨）",
  "",
  "Options:",
  "  --title <text>           タイトルを明示する（省略時は frontmatter → 見出し → ファイル名）",
  "  --tldr <text>            3行要約。改行区切り",
  "  --url <url>              元記事 URL。指定すると URL + content 方式で送る",
  "  --key <text>             冪等キー。省略時はファイルパス",
  "  --store <path>           送信状態の JSON（既定 .state/instapaper-deliveries.json）",
  "  --private-source <name>  Private Source 方式での送信元名"
].join("\n");

export function parseInstapaperSendArgs(args: string[]): InstapaperSendOptions {
  const [mode, ...rest] = args;
  if (mode !== "preview" && mode !== "send") {
    throw new Error(`Mode must be preview or send.\n${INSTAPAPER_SEND_USAGE}`);
  }

  const value = (name: string): string | undefined => {
    const inline = rest.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = rest.indexOf(name);
    if (index < 0) return undefined;
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${name} requires a value.\n${INSTAPAPER_SEND_USAGE}`);
    }
    return next;
  };

  const vaultArtifact = value("--vault-artifact");
  const file = value("--file");
  const useStdin = rest.includes("--stdin");
  const chosen = [vaultArtifact && "vault-artifact", file && "markdown-file", useStdin && "stdin"].filter(
    Boolean
  );
  if (chosen.length !== 1) {
    throw new Error(
      `Choose exactly one of --vault-artifact, --file, --stdin.\n${INSTAPAPER_SEND_USAGE}`
    );
  }

  const sourceUrl = value("--url");
  if (sourceUrl !== undefined && !/^https?:\/\//.test(sourceUrl)) {
    throw new Error(`--url must be http or https.\n${INSTAPAPER_SEND_USAGE}`);
  }

  return {
    mode,
    origin: (vaultArtifact ? "vault-artifact" : file ? "markdown-file" : "stdin") as ReadingSourceOrigin,
    path: vaultArtifact ?? file,
    title: value("--title"),
    tldr: value("--tldr"),
    sourceUrl,
    key: value("--key"),
    storePath: value("--store"),
    privateSourceName: value("--private-source")
  };
}
