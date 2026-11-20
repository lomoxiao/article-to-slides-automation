import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { spawnCli } from "../../shared/cliProcess.js";
import { normalizeNarrationForTts } from "./japaneseNarration.js";
import {
  GEMINI_TTS_PROVIDER_ID,
  addUsage,
  fileUsageStore,
  jstDate,
  synthesizeWithGemini,
  withinDailyLimit,
  type FetchLike,
  type GeminiTtsSettings,
  type UsageStore
} from "./geminiNarration.js";

export const KOKORO_JA_PROVIDER_ID = "kokoro-misaki-ja";

export type NarrationSynthesisInput = {
  textFile: string;
  outputPath: string;
};

export type NarrationSynthesisResult = { providerId: string };

export interface NarrationProvider {
  readonly id: string;
  /** 戻り値は実際に使った合成方法(控えに切り替えた場合は控えの ID)。 */
  synthesize(input: NarrationSynthesisInput): Promise<NarrationSynthesisResult | void>;
}

class KokoroMisakiJaNarrationProvider implements NarrationProvider {
  readonly id = KOKORO_JA_PROVIDER_ID;

  async synthesize(input: NarrationSynthesisInput): Promise<NarrationSynthesisResult> {
    const sourceText = await readFile(input.textFile, "utf8");
    const normalizedText = normalizeNarrationForTts(sourceText);
    if (!normalizedText) throw new Error("Japanese narration is empty after normalization");

    const parsed = path.parse(input.textFile);
    const ttsTextFile = path.join(parsed.dir, `${parsed.name}.tts.txt`);
    await writeFile(ttsTextFile, normalizedText, "utf8");

    const python = path.resolve(config.video.ttsPython);
    const script = path.resolve("scripts", "kokoro-ja-tts.py");
    await access(python);
    await access(script);
    const result = await spawnCli(python, [
      script,
      "--text-file", ttsTextFile,
      "--output", input.outputPath,
      "--voice", config.video.ttsVoice,
      "--speed", String(config.video.ttsSpeed)
    ], {
      timeoutMs: config.video.jobTimeoutMs,
      killTree: true,
      shell: false,
      timeoutError: () => new Error(`Kokoro Japanese TTS timed out after ${config.video.jobTimeoutMs}ms`)
    });
    if (result.exitCode !== 0) {
      throw new Error(`Kokoro Japanese TTS failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
    }
    await access(input.outputPath);
    return { providerId: this.id };
  }
}

export type GeminiNarrationDeps = {
  settings: GeminiTtsSettings;
  maxCharsPerDay: number;
  fetchImpl: FetchLike;
  usage: UsageStore;
  fallback: NarrationProvider;
  now: () => Date;
  log: (message: string) => void;
};

/**
 * Gemini で合成し、失敗したとき・1日の上限を超えるときは控え(Kokoro)で作る。
 * 音声が作れないことより、合成方法が変わることを選ぶ。
 */
export class GeminiNarrationProvider implements NarrationProvider {
  readonly id = GEMINI_TTS_PROVIDER_ID;

  constructor(private readonly deps: GeminiNarrationDeps) {}

  async synthesize(input: NarrationSynthesisInput): Promise<NarrationSynthesisResult> {
    const text = (await readFile(input.textFile, "utf8")).trim();
    const today = jstDate(this.deps.now());
    const usage = await this.deps.usage.read();
    if (!withinDailyLimit(usage, today, text.length, this.deps.maxCharsPerDay)) {
      this.deps.log(`daily limit reached (${usage[today] ?? 0}/${this.deps.maxCharsPerDay} chars); using ${this.deps.fallback.id}`);
      return this.useFallback(input);
    }
    try {
      const { chars } = await synthesizeWithGemini({ text, outputPath: input.outputPath }, this.deps.settings, this.deps.fetchImpl);
      await this.deps.usage.write(addUsage(usage, today, chars)).catch(() => {});
      return { providerId: this.id };
    } catch (error) {
      this.deps.log(`failed; using ${this.deps.fallback.id}: ${error instanceof Error ? error.message : String(error)}`);
      return this.useFallback(input);
    }
  }

  private async useFallback(input: NarrationSynthesisInput): Promise<NarrationSynthesisResult> {
    const result = await this.deps.fallback.synthesize(input);
    return result ?? { providerId: this.deps.fallback.id };
  }
}

// HyperFrames remains the video renderer, but its generic eSpeak-based TTS path is intentionally unused.
const kokoroProvider: NarrationProvider = new KokoroMisakiJaNarrationProvider();
let geminiProvider: NarrationProvider | undefined;
let warnedMissingKey = false;

export type NarrationPurpose = "audio" | "video";

/**
 * 合成方法を選ぶ。TTS_PROVIDER=gemini かつ API キーがあり、用途が GEMINI_TTS_SCOPE の範囲なら Gemini
 * (失敗時は Kokoro に切り替わる)。それ以外は Kokoro。
 * purpose: audio = 1日のまとめ・束などの音声 / video = 動画のナレーション(既定)
 */
export function getNarrationProvider(purpose: NarrationPurpose = "video"): NarrationProvider {
  const tts = config.tts;
  if (tts.provider !== "gemini") return kokoroProvider;
  if (purpose === "video" && tts.gemini.scope !== "all") return kokoroProvider;
  if (!tts.gemini.apiKey) {
    if (!warnedMissingKey) {
      console.warn("[tts] TTS_PROVIDER=gemini but GEMINI_API_KEY is not set; using Kokoro");
      warnedMissingKey = true;
    }
    return kokoroProvider;
  }
  geminiProvider ??= new GeminiNarrationProvider({
    settings: {
      apiKey: tts.gemini.apiKey,
      model: tts.gemini.model,
      voice: tts.gemini.voice,
      style: tts.gemini.style,
      timeoutMs: tts.gemini.timeoutMs
    },
    maxCharsPerDay: tts.gemini.maxCharsPerDay,
    fetchImpl: (url, init) => fetch(url, init),
    usage: fileUsageStore(path.resolve(".runtime", "tts-usage.json")),
    fallback: kokoroProvider,
    now: () => new Date(),
    log: (message) => console.warn(`[tts] gemini ${message}`)
  });
  return geminiProvider;
}
