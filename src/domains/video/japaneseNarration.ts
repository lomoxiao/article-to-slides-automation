const LETTER_READINGS: Record<string, string> = {
  A: "エー", B: "ビー", C: "シー", D: "ディー", E: "イー", F: "エフ",
  G: "ジー", H: "エイチ", I: "アイ", J: "ジェー", K: "ケー", L: "エル",
  M: "エム", N: "エヌ", O: "オー", P: "ピー", Q: "キュー", R: "アール",
  S: "エス", T: "ティー", U: "ユー", V: "ブイ", W: "ダブリュー",
  X: "エックス", Y: "ワイ", Z: "ゼット"
};

const WORD_READINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/HyperFrames/giu, "ハイパーフレームズ"],
  [/Kokoro/giu, "ココロ"],
  [/Misaki/giu, "ミサキ"],
  [/UniDic/giu, "ユニディック"],
  [/ChatGPT/giu, "チャットジーピーティー"],
  [/OpenAI/giu, "オープンエーアイ"],
  [/Claude/giu, "クロード"],
  [/Codex/giu, "コーデックス"],
  [/NotebookLM/giu, "ノートブックエルエム"],
  [/YouTube/giu, "ユーチューブ"],
  [/Google/giu, "グーグル"],
  [/Firebase/giu, "ファイアベース"],
  [/Drive/giu, "ドライブ"],
  [/Slack/giu, "スラック"],
  [/MP4/giu, "エムピーフォー"],
  [/PDF/giu, "ピーディーエフ"],
  [/API/giu, "エーピーアイ"],
  [/URL/giu, "ユーアールエル"],
  [/TTS/giu, "ティーティーエス"],
  [/AI/giu, "エーアイ"],
  [/UI/giu, "ユーアイ"],
  [/UX/giu, "ユーエックス"],
  [/CPU/giu, "シーピーユー"],
  [/GPU/giu, "ジーピーユー"],
  [/SNS/giu, "エスエヌエス"],
  [/SaaS/giu, "サース"],
  [/DX/giu, "ディーエックス"]
];

export function normalizeNarrationForTts(input: string): string {
  let normalized = input.normalize("NFKC");
  for (const [pattern, reading] of WORD_READINGS) {
    normalized = normalized.replace(pattern, reading);
  }
  normalized = normalized.replace(/[A-Z]{2,}/g, (value) =>
    [...value].map((letter) => LETTER_READINGS[letter] ?? letter).join("")
  );
  return normalized
    .replaceAll("%", "パーセント")
    .replace(/[ \t]+/g, " ")
    .trim();
}
