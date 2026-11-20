import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Gemini API の音声合成(TTS)。
 * 仕様は公式ドキュメント(docs/gemini-tts-notes.md に確認日と要点を記録)に従う:
 * - POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 * - ヘッダー x-goog-api-key
 * - 応答の candidates[0].content.parts[0].inlineData.data に base64 の音声(既定は WAV・24kHz・モノラル・16bit)
 * 長い原稿は段落・文の切れ目で分けて順に合成し、PCM をつないで 1 つの WAV にする(ffmpeg は使わない)。
 */
export const GEMINI_TTS_PROVIDER_ID = "gemini-tts";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** 1 回の合成に渡す最大文字数。出力の上限に余裕を持たせるため短めにする。 */
export const GEMINI_TTS_CHUNK_CHARS = 1200;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type GeminiTtsSettings = {
  apiKey: string;
  model: string;
  voice: string;
  style: string;
  timeoutMs: number;
};

/** 原稿を段落 → 文の順に切れ目で分け、各かたまりを maxChars 以下にする。 */
export function splitNarration(text: string, maxChars = GEMINI_TTS_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  const sentences = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .flatMap((paragraph) => {
      const parts = paragraph.match(/[^。！？!?\n]+[。！？!?]*\n?|\n/g) ?? [paragraph];
      return [...parts, "\n\n"];
    });
  for (const sentence of sentences) {
    if (sentence === "\n\n") {
      if (current.length >= maxChars * 0.6) push();
      else if (current) current += "\n\n";
      continue;
    }
    if (current.length + sentence.length > maxChars) push();
    if (sentence.length > maxChars) {
      // 句点の無い極端に長い文は、文字数で切る
      for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars).trim());
      continue;
    }
    current += sentence;
  }
  push();
  return chunks.filter(Boolean);
}

export type PcmAudio = { sampleRate: number; channels: number; bitsPerSample: number; data: Buffer };

/** WAV(RIFF)から形式と PCM を取り出す。 */
export function parseWav(buffer: Buffer): PcmAudio {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Gemini TTS returned audio that is not WAV");
  }
  let offset = 12;
  let format: Omit<PcmAudio, "data"> | undefined;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14)
      };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data chunk appears before fmt chunk");
      // ストリーム由来で size が不定(0xFFFFFFFF 等)の場合は末尾までを使う
      const end = Math.min(buffer.length, body + size);
      return { ...format, data: buffer.subarray(body, end) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** PCM から WAV(RIFF)を組み立てる。 */
export function buildWav(audio: PcmAudio): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = (audio.channels * audio.bitsPerSample) / 8;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + audio.data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(audio.channels, 22);
  header.writeUInt32LE(audio.sampleRate, 24);
  header.writeUInt32LE(audio.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(audio.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(audio.data.length, 40);
  return Buffer.concat([header, audio.data]);
}

/** 複数の WAV をつなぐ。形式が揃っていなければ例外。 */
export function concatWavs(wavs: Buffer[]): Buffer {
  const parts = wavs.map(parseWav);
  const first = parts[0];
  if (!first) throw new Error("no audio to concatenate");
  for (const part of parts) {
    if (part.sampleRate !== first.sampleRate || part.channels !== first.channels || part.bitsPerSample !== first.bitsPerSample) {
      throw new Error("Gemini TTS returned chunks in different audio formats");
    }
  }
  return buildWav({ ...first, data: Buffer.concat(parts.map((part) => part.data)) });
}

/** エラーメッセージから API キーを取り除く(念のため)。 */
export function redactKey(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

export function buildGeminiTtsRequest(text: string, settings: Pick<GeminiTtsSettings, "voice" | "style">): string {
  return JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [{ text, ...(settings.style ? { speech_metadata: { style: settings.style } } : {}) }]
      }
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { voice: settings.voice } }
    }
  });
}

export function extractAudioBase64(responseText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("Gemini TTS response is not JSON");
  }
  const data = (parsed as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: unknown } }> } }>;
  }).candidates?.[0]?.content?.parts?.find((part) => typeof part.inlineData?.data === "string")?.inlineData?.data;
  if (typeof data !== "string" || !data) throw new Error("Gemini TTS response has no audio");
  return data;
}

/** 1 かたまりを合成して WAV を返す。 */
export async function synthesizeChunk(text: string, settings: GeminiTtsSettings, fetchImpl: FetchLike): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(settings.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": settings.apiKey },
      body: buildGeminiTtsRequest(text, settings),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(redactKey(`Gemini TTS HTTP ${response.status}: ${body.replace(/\s+/g, " ").slice(0, 200)}`, settings.apiKey));
    }
    return Buffer.from(extractAudioBase64(body), "base64");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Gemini TTS timed out after ${settings.timeoutMs}ms`, { cause: error });
    }
    throw new Error(redactKey(error instanceof Error ? error.message : String(error), settings.apiKey), { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** 原稿全体を合成して WAV ファイルに書く。戻り値は送った文字数。 */
export async function synthesizeWithGemini(
  input: { text: string; outputPath: string },
  settings: GeminiTtsSettings,
  fetchImpl: FetchLike
): Promise<{ chars: number }> {
  const text = input.text.trim();
  if (!text) throw new Error("narration is empty");
  const chunks = splitNarration(text);
  const wavs: Buffer[] = [];
  for (const chunk of chunks) wavs.push(await synthesizeChunk(chunk, settings, fetchImpl));
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, wavs.length === 1 ? wavs[0]! : concatWavs(wavs));
  return { chars: chunks.reduce((sum, chunk) => sum + chunk.length, 0) };
}

// ---- 1 日あたりの上限(JST の日付ごとに送った文字数を記録する)

export type UsageStore = {
  read: () => Promise<Record<string, number>>;
  write: (usage: Record<string, number>) => Promise<void>;
};

export function fileUsageStore(filePath: string): UsageStore {
  return {
    read: async () => {
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
        return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
      } catch {
        return {};
      }
    },
    write: async (usage) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(usage, null, 2)}\n`, "utf8");
    }
  };
}

export function jstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 上限内なら true。直近 14 日分だけ残す。 */
export function withinDailyLimit(usage: Record<string, number>, today: string, chars: number, maxPerDay: number): boolean {
  return (usage[today] ?? 0) + chars <= maxPerDay;
}

export function addUsage(usage: Record<string, number>, today: string, chars: number): Record<string, number> {
  const next: Record<string, number> = { ...usage, [today]: (usage[today] ?? 0) + chars };
  const keep = Object.keys(next).sort().slice(-14);
  return Object.fromEntries(keep.map((key) => [key, next[key] ?? 0]));
}
