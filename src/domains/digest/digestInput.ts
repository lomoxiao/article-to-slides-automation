import { z } from "zod";

/**
 * news-dashboard (src/digest.ts) が書き出す「今日のまとめ」の材料の契約。
 * 形を変えるときは news-dashboard 側と同時に直す。
 * 材料は別プロセスが作ったファイルなので、信頼せずここで検証する。
 */
export const digestInputSchema = z.object({
  schemaVersion: z.literal(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string().max(64),
  chapters: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(50),
        articles: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(300),
              url: z.string().max(2048).regex(/^https?:\/\//i, "url must be http(s)"),
              source: z.string().trim().max(100),
              summary: z.string().trim().min(1).max(1000),
              importance: z.number().int().min(1).max(5)
            })
          )
          .min(1)
          .max(10)
      })
    )
    .max(10)
});

export type DigestInput = z.infer<typeof digestInputSchema>;

export function parseDigestInput(raw: unknown): DigestInput {
  return digestInputSchema.parse(raw);
}

export function countDigestArticles(input: DigestInput): number {
  return input.chapters.reduce((sum, chapter) => sum + chapter.articles.length, 0);
}
