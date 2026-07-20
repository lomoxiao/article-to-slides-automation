import { extractContent } from "@local/content-extractor";
import { buildDebugExtractorOptions } from "../shared/sourceAggregator.js";
import { usage } from "./lib/cli.js";

// 抽出パイプラインの手動確認用: 複数ページ巡回やセッション設定の動作を単体で試す。
// Usage: npx tsx src/scripts/fetchSourceDebug.ts <url>
const url = process.argv[2];
if (!url) {
  usage("Usage: npx tsx src/scripts/fetchSourceDebug.ts <url>");
}

const content = await extractContent({ url }, buildDebugExtractorOptions());
console.log(
  JSON.stringify(
    {
      url: content.url,
      sourceType: content.sourceType,
      title: content.title,
      textLength: content.markdown.length,
      metadata: content.metadata,
      textHead: content.markdown.slice(0, 200),
      textTail: content.markdown.slice(-200)
    },
    null,
    2
  )
);
