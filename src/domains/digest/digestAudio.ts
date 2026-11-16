import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnCli } from "../../shared/cliProcess.js";
import { upsertArticleAudio } from "../../shared/firebaseArticleStore.js";
import { resourceIntensiveSemaphore } from "../../shared/resourceSemaphore.js";
import { getNarrationProvider } from "../video/narrationProvider.js";
import { probeDuration } from "../video/media.js";

/** RTDB に base64 で置くための上限。超える場合は原稿が長すぎる兆候でもある。 */
export const DIGEST_AUDIO_MAX_BYTES = 2_500_000;

export type DigestAudio = { filePath: string; durationSec: number; sizeBytes: number };

/**
 * 読み上げ原稿を既存の音声合成(Kokoro)で WAV にし、ffmpeg で小さな M4A(AAC・モノラル)へ圧縮する。
 * 動画生成の有効化フラグには依存しない。重い処理なので漫画・動画と同時には走らせない。
 */
export async function synthesizeDigestAudio(jobDir: string, narration: string): Promise<DigestAudio> {
  const textPath = path.join(jobDir, "narration.txt");
  const wavPath = path.join(jobDir, "narration.wav");
  const m4aPath = path.join(jobDir, "narration.m4a");
  await writeFile(textPath, narration, "utf8");

  await resourceIntensiveSemaphore.runExclusive(async () => {
    await getNarrationProvider().synthesize({ textFile: textPath, outputPath: wavPath });
    const result = await spawnCli(
      "ffmpeg",
      ["-y", "-i", wavPath, "-ac", "1", "-c:a", "aac", "-b:a", "32k", "-movflags", "+faststart", m4aPath],
      { timeoutMs: 600_000, killTree: true, shell: false }
    );
    if (result.exitCode !== 0) throw new Error(`ffmpeg failed: ${result.stderr.trim().slice(-500)}`);
  });

  const { size } = await stat(m4aPath);
  if (size > DIGEST_AUDIO_MAX_BYTES) {
    throw new Error(`digest audio is too large: ${size} bytes (max ${DIGEST_AUDIO_MAX_BYTES})`);
  }
  return { filePath: m4aPath, durationSec: Math.round(await probeDuration(m4aPath)), sizeBytes: size };
}

/** 合成した音声ファイルを、記事の音声として保存する(1日のまとめと束で共用)。 */
export async function saveArticleAudioFile(articleUrl: string, audio: DigestAudio): Promise<void> {
  await upsertArticleAudio({
    articleUrl,
    mimeType: "audio/mp4",
    base64: (await readFile(audio.filePath)).toString("base64"),
    durationSec: audio.durationSec,
    sizeBytes: audio.sizeBytes
  });
}
