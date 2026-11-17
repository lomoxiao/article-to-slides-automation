import test from "node:test";
import assert from "node:assert/strict";
import { SourceUnavailableError } from "../shared/sourceErrors.js";
import { BundleError } from "../domains/bundle/bundlePipeline.js";
import {
  generationRequestFailure,
  generationRequestSchema,
  handleBundleRequest,
  handleSaveRequest,
  handleUrlRequest,
  type BundleGenerationRequest,
  type BundleRequestDeps,
  type SaveGenerationRequest,
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
  assert.equal(parse({ kind: "research", prompt: "x", slides: true }).success, false);
});

test("依頼の形: 束は記事ID 2件以上。スライド等がすべて偽でもよい", () => {
  const members = ["url_0123456789ab", "yt_0123456789ab", "txt_0123456789ab"];
  assert.equal(parse({ kind: "bundle", members }).success, true);
  assert.equal(parse({ kind: "bundle", members, audio: true, slides: true, title: "今週のAI" }).success, true);
  assert.equal(parse({ kind: "bundle", members: ["url_0123456789ab"] }).success, false);
  assert.equal(parse({ kind: "bundle", members: ["url_0123456789ab", "url_0123456789ab"] }).success, false);
  // 束そのものや、IDの形でないものはメンバーにできない
  assert.equal(parse({ kind: "bundle", members: ["url_0123456789ab", "bnd_0123456789ab"] }).success, false);
  assert.equal(parse({ kind: "bundle", members: ["url_0123456789ab", "https://example.com/a"] }).success, false);
  assert.equal(parse({ kind: "bundle", members: ["url_0123456789ab", "../secrets"] }).success, false);
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

function bundleSetup(options: { error?: Error } = {}) {
  const calls = { bundles: [] as string[][], video: 0, manga: 0, slides: [] as string[], updates: [] as Array<Record<string, unknown>> };
  const deps: BundleRequestDeps = {
    runBundle: async (input) => {
      calls.bundles.push(input.memberIds);
      if (options.error) throw options.error;
      return {
        articleId: "bnd_0123456789ab",
        url: "bundle:bnd_0123456789ab",
        title: "束のタイトル",
        body: "束の本文",
        included: 2,
        missing: 1,
        audio: Boolean(input.audio),
        digestsCreated: 2
      };
    },
    enqueueVideo: async () => {
      calls.video += 1;
    },
    enqueueManga: () => {
      calls.manga += 1;
    },
    runSlides: async (input) => {
      calls.slides.push(`${input.url}|${input.sourceTitle}|${input.sourceText}`);
    }
  };
  const update = async (patch: Record<string, unknown>) => {
    calls.updates.push(patch);
  };
  const request = (overrides: Record<string, unknown> = {}) => {
    const parsed = parse({ kind: "bundle", members: ["url_0123456789ab", "url_ba9876543210", "txt_0123456789ab"], ...overrides });
    assert.equal(parsed.success, true);
    return parsed.data as BundleGenerationRequest;
  };
  return { deps, calls, update, request };
}

test("束の依頼: 束を作って結果を依頼に書き、done にする(追加の生成は選んだものだけ)", async () => {
  const { deps, calls, update, request } = bundleSetup();
  await handleBundleRequest(request({ audio: true }), update, deps);

  assert.equal(calls.bundles.length, 1);
  assert.deepEqual(calls.updates[0], { articleId: "bnd_0123456789ab", bundle: { included: 2, missing: 1, audio: true } });
  assert.deepEqual(calls.updates.at(-1), { status: "done", articleId: "bnd_0123456789ab" });
  assert.equal(calls.video + calls.manga + calls.slides.length, 0);
});

test("束の依頼: スライドを選ぶと、束の本文を材料にして束の記事に付ける", async () => {
  const { deps, calls, update, request } = bundleSetup();
  await handleBundleRequest(request({ slides: true }), update, deps);
  assert.deepEqual(calls.slides, ["bundle:bnd_0123456789ab|束のタイトル|束の本文"]);
});

test("束の依頼: 束にできなかった場合は、理由つきの failed になる", async () => {
  const { deps, update, request } = bundleSetup({ error: new BundleError("束にできる記事が2本未満です。") });
  await assert.rejects(handleBundleRequest(request(), update, deps), /2本未満/);
  const failure = generationRequestFailure(new BundleError("束にできる記事が2本未満です。"));
  assert.equal(failure.errorCode, "BUNDLE_FAILED");
  assert.match(failure.statusMessage ?? "", /2本未満/);
});

test("依頼の形: 保存だけの依頼は公開URL 1件。スライド等は指定できない", () => {
  assert.equal(parse({ kind: "save", urls: ["https://example.com/a"] }).success, true);
  assert.equal(parse({ kind: "save", urls: ["https://example.com/a"], title: "記事の題" }).success, true);
  assert.equal(parse({ kind: "save", urls: [] }).success, false);
  assert.equal(parse({ kind: "save", urls: ["https://example.com/a", "https://example.com/b"] }).success, false);
  assert.equal(parse({ kind: "save", urls: ["https://example.com/a"], slides: true }).success, false);
  assert.equal(parse({ kind: "save", urls: ["http://localhost:3000/"] }).success, false);
  assert.equal(parse({ kind: "save", urls: ["javascript:alert(1)"] }).success, false);
});

test("保存だけの依頼: 記事を登録して done にする(本文の取得や生成はしない)", async () => {
  const registered: Array<{ url: string; title?: string; registeredFrom: string }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const parsed = parse({ kind: "save", urls: ["https://example.com/a"], title: "  記事の\n題  " });
  assert.equal(parsed.success, true);
  await handleSaveRequest(
    parsed.data as SaveGenerationRequest,
    async (patch) => {
      updates.push(patch);
    },
    {
      register: async (input) => {
        registered.push(input);
        return { articleId: "url_0123456789ab" };
      }
    }
  );
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.registeredFrom, "bookmarklet");
  assert.equal(registered[0]?.title, "記事の 題");
  assert.equal(registered[0]?.url, "https://example.com/a");
  assert.deepEqual(updates, [{ status: "done", articleId: "url_0123456789ab" }]);
});
