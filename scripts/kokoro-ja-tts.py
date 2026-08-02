from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline


def as_numpy(audio: object) -> np.ndarray:
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    return np.asarray(audio, dtype=np.float32).reshape(-1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Japanese Kokoro TTS using Misaki G2P")
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--voice", default="jf_alpha")
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()

    if args.speed <= 0:
        raise ValueError("--speed must be positive")

    text_path = Path(args.text_file)
    output_path = Path(args.output)
    text = text_path.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("TTS input is empty")

    pipeline = KPipeline(lang_code="j")
    chunks: list[np.ndarray] = []
    phonemes: list[str] = []
    for _graphemes, chunk_phonemes, audio in pipeline(
        text,
        voice=args.voice,
        speed=args.speed,
        split_pattern=r"\n+",
    ):
        chunk = as_numpy(audio)
        if chunk.size:
            chunks.append(chunk)
            phonemes.append(str(chunk_phonemes))

    if not chunks:
        raise RuntimeError("Kokoro produced no audio")

    samples = np.concatenate(chunks)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, samples, 24000)

    print(json.dumps({
        "provider": "kokoro-misaki-ja",
        "voice": args.voice,
        "sampleRate": 24000,
        "durationSeconds": round(float(samples.size) / 24000, 3),
        "phonemes": phonemes,
        "outputPath": str(output_path.resolve()),
    }, ensure_ascii=True))


if __name__ == "__main__":
    main()
