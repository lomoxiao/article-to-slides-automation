import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { spawnCli } from "../../shared/cliProcess.js";
import { normalizeNarrationForTts } from "./japaneseNarration.js";

export const KOKORO_JA_PROVIDER_ID = "kokoro-misaki-ja";

export type NarrationSynthesisInput = {
  textFile: string;
  outputPath: string;
};

export interface NarrationProvider {
  readonly id: string;
  synthesize(input: NarrationSynthesisInput): Promise<void>;
}

class KokoroMisakiJaNarrationProvider implements NarrationProvider {
  readonly id = KOKORO_JA_PROVIDER_ID;

  async synthesize(input: NarrationSynthesisInput): Promise<void> {
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
  }
}

// The runtime registers exactly one TTS implementation. HyperFrames remains the
// video renderer, but its generic eSpeak-based TTS path is intentionally unused.
const activeNarrationProvider: NarrationProvider = new KokoroMisakiJaNarrationProvider();

export function getNarrationProvider(): NarrationProvider {
  return activeNarrationProvider;
}
