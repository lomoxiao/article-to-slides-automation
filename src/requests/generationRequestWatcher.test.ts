import test from "node:test";
import assert from "node:assert/strict";
import { SourceUnavailableError } from "../shared/sourceErrors.js";
import {
  generationRequestFailure,
  generationRequestSchema,
  handleUrlRequest,
  type UrlGenerationRequest,
  type UrlRequestDeps
} from "./generationRequestWatcher.js";

const base = {
  ownerUid: "user",
  status: "queued",
  createdAt: "2026-11-16T00:00:00.000Z",
  trigger: { provider: "web" }
};
const mangaOptions = { artStyle: "A", treatment: "B" };
const parse = (value: Record<string, unknown>) => generationRequestSchema.safeParse({ ...base, ...value });

test("依頼の形: テキスト投入は従来どおり通る", () => {
  assert.equal(parse({ kind: "text", text: "本文", slides: true }).success, true);
  assert.equal(parse({ kind: "text", slides: true }).success, false);
});

test("依頼の形: URL投入は1〜3件の公開URLを受け付ける", () => {
  assert.equal(parse({ kind: "url", urls: ["https://example.com/a"], slides: true }).success, true);
  assert.equal(parse({ kind: "url", urls: ["https://a.example/1", "https://b.example/2", "https://c.example/3"], slides: true }).success, true);
  assert.equal(parse({ kind: "url", urls: [], slides: true }).success, false);
  assert.equal(parse({ kind: "url", urls: ["https://a.example/1", "https://b.example/2", "https://c.example/3", "https://d.example/4"], slides: true }).success, false);
  assert.equal(parse({ kind: "url", slides: true }).success, false);
});

test("依頼の形: 内部宛て・http(s)以外のURLは拒否する", () => {
  for (const url of ["http://localhost:3000/", "http://192.168.1.1/", "file:///etc/passwd", "javascript:alert(1)", "ただの文字"]) {
    assert.equal(parse({ kind: "url", urls: [url], slides: true }).success, false, url);
  }
});

test("依頼の形: 漫画・動画を含む依頼はURL1件のみ。生成対象なしは拒否", () => {
  const two = ["https://a.example/1", "https://b.example/2"];
  assert.equal(parse({ kind: "url", urls: two, slides: true }).success, true);
  assert.equal(parse({ kind: "url", urls: two, slides: true, video: true }).success, false);
  assert.equal(parse({ kind: "url", urls: two, manga: true, mangaOptions }).success, false);
  assert.equal(parse({ kind: "url", urls: ["https://a.example/1"], manga: true, mangaOptions }).success, true);
  assert.equal(parse({ kind: "url", urls: ["https://a.example/1"] }).success, false);
  assert.equal(parse({ kind: "url", urls: ["https://a.example/1"], manga: true }).success, false);
});

test("依頼の形: 未知の種類は拒否する", () => {
  assert.equal(parse({ kind: "bundle", members: ["url_x"], slides: true }).success, false);
});

function urlRequest(overrides: Record<string, unknown> = {}): UrlGenerationRequest {
  const parsed = parse({ kind: "url", urls: ["https://example.com/a"], slides: true, ...overrides });
  assert.equal(parsed.success, true);
  return parsed.data as UrlGenerationRequest;
}

function setup(options: { ingestError?: Error } = {}) {
  const calls = {
    registered: [] as string[],
    ingested: [] as string[],
    unavailable: [] as string[],
    video: [] as string[],
    manga: [] as string[],
    slides: [] as Array<{ urls: string[]; sourceTitle?: string }>,
    updates: [] as Array<Record<string, unknown>>
  };
  const deps: UrlRequestDeps = {
    register: async (url) => {
      calls.registered.push(url);
    },
    ingest: async (url) => {
      calls.ingested.push(url);
      if (options.ingestError) throw options.ingestError;
      return { title: "取得した記事", text: "本文".repeat(500), quality: { verdict: "full", chars: 1000, reasons: [] }, reused: false };
    },
    markSourceUnavailable: async (url) => {
      calls.unavailable.push(url);
    },
    enqueueVideo: async (input) => {
      calls.video.push(input.url);
    },
    enqueueManga: (input) => {
      calls.manga.push(input.url);
    },
    runSlides: async (input) => {
      calls.slides.push({ urls: input.urls, sourceTitle: input.sourceTitle });
    }
  };
  const update = async (patch: Record<string, unknown>) => {
    calls.updates.push(patch);
  };
  return { deps, calls, update };
}

test("URL依頼: 取り込み結果を依頼に書いてから生成へ進み、最後に done にする", async () => {
  const { deps, calls, update } = setup();
  await handleUrlRequest(urlRequest({ slides: true, video: true, manga: true, mangaOptions }), update, deps);

  assert.deepEqual(calls.registered, ["https://example.com/a"]);
  assert.deepEqual(calls.ingested, ["https://example.com/a"]);
  assert.deepEqual(calls.video, ["https://example.com/a"]);
  assert.deepEqual(calls.manga, ["https://example.com/a"]);
  assert.deepEqual(calls.slides, [{ urls: ["https://example.com/a"], sourceTitle: "取得した記事" }]);
  assert.deepEqual(calls.updates[0]?.ingest, { verdict: "full", chars: 1000, reused: false });
  assert.equal(calls.updates.at(-1)?.status, "done");
  assert.match(String(calls.updates.at(-1)?.articleId), /^url_[0-9a-f]{12}$/);
});

test("URL依頼: 本文が取れなければ何も生成せず、理由つきで failed にする", async () => {
  const error = new SourceUnavailableError("https://example.com/a", "http_403", "本文が取れていません（サイトに取得を拒否されました）。");
  const { deps, calls, update } = setup({ ingestError: error });
  await handleUrlRequest(urlRequest({ slides: true, video: true }), update, deps);

  assert.deepEqual(calls.video, []);
  assert.deepEqual(calls.manga, []);
  assert.deepEqual(calls.slides, []);
  assert.deepEqual(calls.unavailable, ["https://example.com/a"]);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0]?.status, "failed");
  assert.equal(calls.updates[0]?.errorCode, "SOURCE_UNAVAILABLE");
  assert.match(String(calls.updates[0]?.statusMessage), /本文が取れていません/);
});

test("URL依頼: 取り込み以外の失敗はそのまま投げ、呼び出し側で failed にする", async () => {
  const { deps, update } = setup({ ingestError: new Error("database unavailable") });
  await assert.rejects(handleUrlRequest(urlRequest(), update, deps), /database unavailable/);
});

test("URL依頼: URLを掃除してから扱う", async () => {
  const { deps, calls, update } = setup();
  await handleUrlRequest(urlRequest({ urls: ["https://example.com/a?x=1&amp;y=2"] }), update, deps);
  assert.deepEqual(calls.ingested, ["https://example.com/a?x=1&y=2"]);
});

test("URL依頼: 複数URL(スライドのみ)は事前の取り込みをせず、スライド生成に全URLを渡す", async () => {
  const { deps, calls, update } = setup();
  await handleUrlRequest(urlRequest({ urls: ["https://a.example/1", "https://b.example/2"] }), update, deps);

  assert.deepEqual(calls.ingested, []);
  assert.deepEqual(calls.slides, [{ urls: ["https://a.example/1", "https://b.example/2"], sourceTitle: undefined }]);
  assert.equal(calls.updates.at(-1)?.status, "done");
});

test("失敗の記録: 生成途中で本文が取れないと分かった場合も、理由つきの failed になる", () => {
  const failure = generationRequestFailure(new SourceUnavailableError("https://b.example/2", "timeout", "本文が取れていません（時間切れ）。"));
  assert.equal(failure.errorCode, "SOURCE_UNAVAILABLE");
  assert.match(failure.statusMessage ?? "", /本文が取れていません/);
  assert.deepEqual(generationRequestFailure(new Error("x")), { status: "failed", error: "x" });
});
