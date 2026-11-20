import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addUsage,
  buildGeminiTtsRequest,
  buildWav,
  concatWavs,
  extractAudioBase64,
  jstDate,
  parseWav,
  redactKey,
  splitNarration,
  synthesizeWithGemini,
  withinDailyLimit,
  type FetchLike,
  type GeminiTtsSettings
} from "./geminiNarration.js";
import { GeminiNarrationProvider, type NarrationProvider } from "./narrationProvider.js";

const KEY = "test-key-should-never-leak";
const settings: GeminiTtsSettings = { apiKey: KEY, model: "gemini-3.8-flash-lite-tts", voice: "Kore", style: "calm", timeoutMs: 5000 };

const wav = (samples: number[]) =>
  buildWav({ sampleRate: 24000, channels: 1, bitsPerSample: 16, data: Buffer.from(Int16Array.from(samples).buffer) });
const okResponse = (audio: Buffer) =>
  JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: audio.toString("base64") } }] } }] });

function fakeFetch(responses: Array<{ ok?: boolean; status?: number; body: string } | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return { ok: next.ok ?? true, status: next.status ?? 200, text: async () => next.body };
  };
  return { fetchImpl, calls };
}

test("原稿の分割: 段落と文の切れ目で分け、上限を超えない。短い原稿は1つのまま", () => {
  assert.deepEqual(splitNarration("おはようございます。今日のまとめです。"), ["おはようございます。今日のまとめです。"]);
  const paragraph = "これは文です。".repeat(60);
  const chunks = splitNarration(`${paragraph}\n\n${paragraph}\n\n${paragraph}`, 500);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.ok(chunks.every((chunk) => chunk.endsWith("。")));
  assert.equal(chunks.join("").replace(/\s+/g, ""), `${paragraph}${paragraph}${paragraph}`);
  // 句点の無い長い文も上限で切る
  assert.ok(splitNarration("あ".repeat(1300), 500).every((chunk) => chunk.length <= 500));
});

test("WAV: 組み立て・読み取り・連結ができ、形式が違えば連結しない", () => {
  const joined = parseWav(concatWavs([wav([1, 2, 3]), wav([4, 5])]));
  assert.equal(joined.sampleRate, 24000);
  assert.deepEqual(Array.from(new Int16Array(joined.data.buffer, joined.data.byteOffset, joined.data.length / 2)), [1, 2, 3, 4, 5]);
  const other = buildWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, data: Buffer.alloc(4) });
  assert.throws(() => concatWavs([wav([1]), other]), /different audio formats/);
  assert.throws(() => parseWav(Buffer.from("not a wav file at all")), /not WAV/);
});

test("リクエスト: 公式の形(contents・generationConfig・speechConfig.voiceConfig.voice)で送る", () => {
  const body = JSON.parse(buildGeminiTtsRequest("こんにちは", { voice: "Kore", style: "calm" }));
  assert.deepEqual(body.contents[0].parts[0], { text: "こんにちは", speech_metadata: { style: "calm" } });
  assert.deepEqual(body.generationConfig, { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { voice: "Kore" } } });
  assert.equal(JSON.parse(buildGeminiTtsRequest("x", { voice: "Kore", style: "" })).contents[0].parts[0].speech_metadata, undefined);
  assert.throws(() => extractAudioBase64(JSON.stringify({ candidates: [] })), /no audio/);
  assert.throws(() => extractAudioBase64("<html>"), /not JSON/);
});

test("合成: かたまりごとに送り、1つの WAV にする。キーはヘッダーだけに載る", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gemini-tts-"));
  const outputPath = path.join(dir, "out.wav");
  const { fetchImpl, calls } = fakeFetch([{ body: okResponse(wav([1, 2])) }, { body: okResponse(wav([3])) }]);
  const text = `${"一つ目の段落です。".repeat(80)}\n\n${"二つ目の段落です。".repeat(80)}`;
  const result = await synthesizeWithGemini({ text, outputPath }, settings, fetchImpl);
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.url ?? "", /models\/gemini-3\.8-flash-lite-tts:generateContent$/);
  assert.equal(calls[0]?.headers["x-goog-api-key"], KEY);
  assert.doesNotMatch(calls[0]?.url ?? "", new RegExp(KEY));
  assert.equal(result.chars, text.replace(/\n\n/, "").length);
  const audio = parseWav(await readFile(outputPath));
  assert.equal(audio.data.length, 6);
});

test("合成: HTTP エラーは状態と本文の先頭だけを伝え、キーを含めない", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gemini-tts-"));
  const { fetchImpl } = fakeFetch([{ ok: false, status: 403, body: `{"error":{"message":"API key ${KEY} not valid"}}` }]);
  await assert.rejects(
    synthesizeWithGemini({ text: "こんにちは。", outputPath: path.join(dir, "out.wav") }, settings, fetchImpl),
    (error: Error) => /HTTP 403/.test(error.message) && !error.message.includes(KEY)
  );
  assert.equal(redactKey(`a ${KEY} b`, KEY), "a [redacted] b");
  await assert.rejects(synthesizeWithGemini({ text: "  ", outputPath: path.join(dir, "x.wav") }, settings, fetchImpl), /empty/);
});

test("1日の上限: JST の日付で数え、14日分だけ残す", () => {
  assert.equal(jstDate(new Date("2026-11-18T15:30:00Z")), "2026-11-19");
  assert.equal(withinDailyLimit({ "2026-11-18": 19000 }, "2026-11-18", 1000, 20000), true);
  assert.equal(withinDailyLimit({ "2026-11-18": 19500 }, "2026-11-18", 1000, 20000), false);
  let usage: Record<string, number> = {};
  for (let day = 1; day <= 20; day += 1) usage = addUsage(usage, `2026-11-${String(day).padStart(2, "0")}`, 10);
  assert.equal(Object.keys(usage).length, 14);
  assert.equal(addUsage({ "2026-11-18": 5 }, "2026-11-18", 7)["2026-11-18"], 12);
});

async function providerSetup(options: { responses: Array<{ ok?: boolean; status?: number; body: string } | Error>; usage?: Record<string, number>; max?: number }) {
  const dir = await mkdtemp(path.join(tmpdir(), "gemini-provider-"));
  const textFile = path.join(dir, "narration.txt");
  await writeFile(textFile, "今日のまとめです。", "utf8");
  const fallbackCalls: string[] = [];
  const fallback: NarrationProvider = {
    id: "kokoro-misaki-ja",
    synthesize: async (input) => {
      fallbackCalls.push(input.outputPath);
      await writeFile(input.outputPath, wav([9]));
    }
  };
  let stored = { ...(options.usage ?? {}) };
  const logs: string[] = [];
  const { fetchImpl, calls } = fakeFetch(options.responses);
  const provider = new GeminiNarrationProvider({
    settings,
    maxCharsPerDay: options.max ?? 20000,
    fetchImpl,
    usage: { read: async () => stored, write: async (usage) => { stored = usage; } },
    fallback,
    now: () => new Date("2026-11-18T03:00:00Z"),
    log: (message) => logs.push(message)
  });
  return { provider, input: { textFile, outputPath: path.join(dir, "out.wav") }, fallbackCalls, calls, logs, usage: () => stored };
}

test("切り替え: 成功すれば gemini-tts、使った文字数を記録する", async () => {
  const setup = await providerSetup({ responses: [{ body: okResponse(wav([1])) }] });
  assert.deepEqual(await setup.provider.synthesize(setup.input), { providerId: "gemini-tts" });
  assert.equal(setup.fallbackCalls.length, 0);
  assert.equal(setup.usage()["2026-11-18"], "今日のまとめです。".length);
});

test("切り替え: Gemini が失敗したら Kokoro で作り、理由をログに残す(キーは出さない)", async () => {
  const setup = await providerSetup({ responses: [{ ok: false, status: 500, body: `oops ${KEY}` }] });
  assert.deepEqual(await setup.provider.synthesize(setup.input), { providerId: "kokoro-misaki-ja" });
  assert.equal(setup.fallbackCalls.length, 1);
  assert.match(setup.logs[0] ?? "", /HTTP 500/);
  assert.ok(setup.logs.every((line) => !line.includes(KEY)));
  assert.deepEqual(setup.usage(), {});
});

test("切り替え: 1日の上限を超えるなら Gemini を呼ばずに Kokoro", async () => {
  const setup = await providerSetup({ responses: [], usage: { "2026-11-18": 19995 }, max: 20000 });
  assert.deepEqual(await setup.provider.synthesize(setup.input), { providerId: "kokoro-misaki-ja" });
  assert.equal(setup.calls.length, 0);
  assert.match(setup.logs[0] ?? "", /daily limit/);
});
