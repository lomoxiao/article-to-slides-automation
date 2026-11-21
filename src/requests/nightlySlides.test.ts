import test from "node:test";
import assert from "node:assert/strict";
import type { InboxCandidate } from "../shared/firebaseArticleStore.js";
import {
  isInNightWindow,
  nightKey,
  nightlySlidesTick,
  registeredJstDate,
  selectNightlyTargets,
  targetRegistrationDate,
  type NightlyRecord,
  type NightlySlidesDeps
} from "./nightlySlides.js";

const at = (iso: string) => new Date(iso);

function candidate(articleId: string, patch: Partial<InboxCandidate> = {}): InboxCandidate {
  return {
    articleId,
    canonicalUrl: `https://example.com/${articleId}`,
    title: articleId,
    sourceKind: "web",
    registeredFrom: "shortcut",
    registeredAt: "2026-11-21T12:00:00+09:00",
    deleted: false,
    hasArtifact: false,
    hasTldr: true,
    summaryStatus: "done",
    summaryAttempts: 1,
    ...patch
  };
}

test("時間帯: 0〜5時(日本時間)の中だけ動く。日をまたぐ時間帯も扱える", () => {
  assert.equal(isInNightWindow(at("2026-11-21T15:00:00Z"), 0, 5), true); // 0:00 JST
  assert.equal(isInNightWindow(at("2026-11-21T19:59:00Z"), 0, 5), true); // 4:59 JST
  assert.equal(isInNightWindow(at("2026-11-21T20:00:00Z"), 0, 5), false); // 5:00 JST
  assert.equal(isInNightWindow(at("2026-11-21T14:59:00Z"), 0, 5), false); // 23:59 JST
  assert.equal(isInNightWindow(at("2026-11-21T13:00:00Z"), 22, 5), true); // 22:00 JST
  assert.equal(isInNightWindow(at("2026-11-21T17:00:00Z"), 22, 5), true); // 2:00 JST
});

test("対象の日: 0時始まりなら前日に登録された記事、22時始まりなら始まった日の記事", () => {
  const night = at("2026-11-21T16:30:00Z"); // 11/22 1:30 JST
  assert.equal(nightKey(night, 0, 5), "2026-11-22");
  assert.equal(targetRegistrationDate(night, 0, 5), "2026-11-21");
  assert.equal(nightKey(night, 22, 5), "2026-11-21");
  assert.equal(targetRegistrationDate(night, 22, 5), "2026-11-21");
  assert.equal(registeredJstDate("2026-11-21T23:59:00+09:00"), "2026-11-21");
  assert.equal(registeredJstDate("2026-11-21T15:00:00Z"), "2026-11-22");
  assert.equal(registeredJstDate("bad"), "");
});

test("対象の選び方: その日の受信箱の記事で、3行要約があり本文が取れたものだけ。古い順に上限まで", () => {
  const list = [
    candidate("url_late", { registeredAt: "2026-11-21T22:00:00+09:00" }),
    candidate("url_early", { registeredAt: "2026-11-21T08:00:00+09:00" }),
    candidate("url_yesterday", { registeredAt: "2026-11-20T22:00:00+09:00" }),
    candidate("url_tonight", { registeredAt: "2026-11-22T00:10:00+09:00" }),
    candidate("url_made", { hasArtifact: true }),
    candidate("url_nosummary", { hasTldr: false, summaryStatus: "" }),
    candidate("url_unavailable", { hasTldr: false, summaryStatus: "unavailable" }),
    candidate("url_deleted", { deleted: true }),
    candidate("txt_digest", { sourceKind: "text", registeredFrom: "daily-digest" }),
    candidate("yt_video", { sourceKind: "youtube", registeredAt: "2026-11-21T09:00:00+09:00" }),
    candidate("url_tried", { registeredAt: "2026-11-21T07:00:00+09:00" })
  ];
  const picked = selectNightlyTargets(list, { date: "2026-11-21", exclude: new Set(["url_tried"]), max: 5 });
  assert.deepEqual(picked.map((item) => item.articleId), ["url_early", "yt_video", "url_late"]);
  assert.deepEqual(
    selectNightlyTargets(list, { date: "2026-11-21", exclude: new Set(), max: 2 }).map((item) => item.articleId),
    ["url_tried", "url_early"]
  );
  assert.deepEqual(selectNightlyTargets(list, { date: "2026-11-21", exclude: new Set(), max: 0 }), []);
});

function setup(options: { now?: string; record?: NightlyRecord | null; fail?: string[]; list?: InboxCandidate[]; max?: number } = {}) {
  let now = at(options.now ?? "2026-11-21T16:00:00Z"); // 11/22 1:00 JST
  const generated: string[] = [];
  const writes: NightlyRecord[] = [];
  let stored = options.record ?? null;
  const deps: NightlySlidesDeps = {
    now: () => now,
    max: options.max ?? 5,
    startHour: 0,
    endHour: 5,
    list: async () =>
      options.list ??
      Array.from({ length: 7 }, (_, index) => candidate(`url_${index}`, { registeredAt: `2026-11-21T1${index}:00:00+09:00` })),
    generate: async (article) => {
      generated.push(article.articleId);
      if (options.fail?.includes(article.articleId)) throw new Error("boom");
    },
    record: {
      read: async () => stored,
      write: async (record) => {
        stored = JSON.parse(JSON.stringify(record));
        writes.push(stored as NightlyRecord);
      }
    },
    log: () => {}
  };
  return { deps, generated, writes, setNow: (iso: string) => (now = at(iso)), stored: () => stored };
}

test("夜間: 一晩に最大5本。失敗した記事も本数に数え、同じ夜には繰り返さない", async () => {
  const { deps, generated, stored } = setup({ fail: ["url_1"] });
  const result = await nightlySlidesTick(deps);
  assert.deepEqual(result, { night: "2026-11-22", done: 4, failed: 1, remaining: 0 });
  assert.deepEqual(generated, ["url_0", "url_1", "url_2", "url_3", "url_4"]);
  assert.deepEqual(stored()?.attempted.map((item) => `${item.articleId}:${item.result}`), [
    "url_0:done",
    "url_1:failed",
    "url_2:done",
    "url_3:done",
    "url_4:done"
  ]);
  // 同じ夜にもう一度確認しても、上限に達しているので作らない
  const again = await nightlySlidesTick(deps);
  assert.deepEqual(again, { night: "2026-11-22", done: 0, failed: 0, remaining: 0 });
  assert.equal(generated.length, 5);
});

test("夜間: 再起動しても、その夜に試した記事は作り直さず、残りの本数だけ作る", async () => {
  const { deps, generated } = setup({
    record: { night: "2026-11-22", attempted: [{ articleId: "url_0", result: "done", at: "x" }, { articleId: "url_1", result: "failed", at: "x" }] }
  });
  const result = await nightlySlidesTick(deps);
  assert.deepEqual(generated, ["url_2", "url_3", "url_4"]);
  assert.deepEqual(result, { night: "2026-11-22", done: 3, failed: 0, remaining: 0 });
});

test("夜間: 前の夜の記録は使わない。時間帯の外では何もしない", async () => {
  const old = setup({ record: { night: "2026-11-21", attempted: [{ articleId: "url_0", result: "done", at: "x" }] }, max: 1 });
  await nightlySlidesTick(old.deps);
  assert.deepEqual(old.generated, ["url_0"]);

  const day = setup({ now: "2026-11-22T03:00:00Z" }); // 12:00 JST
  assert.equal(await nightlySlidesTick(day.deps), "outside-window");
  assert.deepEqual(day.generated, []);
});

test("夜間: 5時を過ぎたら新しく始めない(作っている途中の1本は最後まで作る)", async () => {
  const { deps, generated, setNow } = setup();
  const original = deps.generate;
  deps.generate = async (article) => {
    await original(article);
    setNow("2026-11-21T20:01:00Z"); // 5:01 JST
  };
  const result = await nightlySlidesTick(deps);
  assert.deepEqual(generated, ["url_0"]);
  assert.deepEqual(result, { night: "2026-11-22", done: 1, failed: 0, remaining: 4 });
});
