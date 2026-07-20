import test from "node:test";
import assert from "node:assert/strict";
import {
  MANGA_GENERATE_PREFIX,
  SLIDE_GENERATE_PREFIX,
  getRequestId,
  isChannelAllowed,
  isGenerateMessage,
  stripPrefix
} from "./messageGate.js";
import { RecentRequestIds } from "./recentRequestIds.js";

const CHANNEL = "C12345678";

const baseEvent = {
  type: "message",
  text: `${SLIDE_GENERATE_PREFIX} --url https://a.com`,
  channel: CHANNEL
};

test("isGenerateMessage accepts a prefixed message in the allowed channel", () => {
  assert.ok(isGenerateMessage(baseEvent, SLIDE_GENERATE_PREFIX, CHANNEL));
});

test("isGenerateMessage rejects wrong type, prefix, channel, and subtype", () => {
  assert.ok(!isGenerateMessage(undefined, SLIDE_GENERATE_PREFIX, CHANNEL));
  assert.ok(!isGenerateMessage({ ...baseEvent, type: "reaction_added" }, SLIDE_GENERATE_PREFIX, CHANNEL));
  assert.ok(!isGenerateMessage({ ...baseEvent, text: "hello" }, SLIDE_GENERATE_PREFIX, CHANNEL));
  assert.ok(!isGenerateMessage({ ...baseEvent, channel: "C99999999" }, SLIDE_GENERATE_PREFIX, CHANNEL));
  assert.ok(!isGenerateMessage({ ...baseEvent, subtype: "message_changed" }, SLIDE_GENERATE_PREFIX, CHANNEL));
});

test("isGenerateMessage allows bot_message subtype (viewer posts via bot)", () => {
  assert.ok(isGenerateMessage({ ...baseEvent, subtype: "bot_message" }, SLIDE_GENERATE_PREFIX, CHANNEL));
});

test("isChannelAllowed treats unset or sample channel id as allow-all", () => {
  assert.ok(isChannelAllowed("Cany", undefined));
  assert.ok(isChannelAllowed("Cany", "C0000000000"));
  assert.ok(!isChannelAllowed("Cother", CHANNEL));
  assert.ok(isChannelAllowed(CHANNEL, CHANNEL));
});

test("stripPrefix removes the prefix and surrounding whitespace only when present", () => {
  assert.equal(stripPrefix(`  ${MANGA_GENERATE_PREFIX}  --url https://a.com `, MANGA_GENERATE_PREFIX), "--url https://a.com");
  assert.equal(stripPrefix("--url https://a.com", MANGA_GENERATE_PREFIX), "--url https://a.com");
});

test("getRequestId prefers client_msg_id and falls back to channel:ts", () => {
  assert.equal(getRequestId({ client_msg_id: "abc", channel: CHANNEL, ts: "1.2" }), "abc");
  assert.equal(getRequestId({ channel: CHANNEL, ts: "1.2" }), `${CHANNEL}:1.2`);
  assert.equal(getRequestId({}), "unknown:unknown");
});

test("RecentRequestIds dedups and evicts the oldest beyond the cap", () => {
  const ids = new RecentRequestIds(3);
  ids.remember("a");
  ids.remember("b");
  ids.remember("c");
  assert.ok(ids.has("a"));

  ids.remember("d");
  assert.ok(!ids.has("a"));
  assert.ok(ids.has("b"));
  assert.ok(ids.has("d"));
});
