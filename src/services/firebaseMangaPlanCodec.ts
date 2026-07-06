import { mangaPlan21Schema, type MangaPlan21 } from "../contracts/mangaPlan21.js";

const EMPTY_ARRAY = Object.freeze({ __mangaPlanCodec: "empty_array" });
const EMPTY_OBJECT = Object.freeze({ __mangaPlanCodec: "empty_object" });
const NULL = Object.freeze({ __mangaPlanCodec: "null" });

export function encodeMangaPlanForFirebase(plan: MangaPlan21): unknown { return encode(mangaPlan21Schema.parse(plan)); }
export function decodeMangaPlanFromFirebase(value: unknown): MangaPlan21 { return mangaPlan21Schema.parse(decode(value)); }
function encode(value: unknown): unknown {
  if (value === null) return NULL;
  if (Array.isArray(value)) return value.length ? value.map(encode) : EMPTY_ARRAY;
  if (typeof value === "object") { const entries = Object.entries(value as Record<string, unknown>); return entries.length ? Object.fromEntries(entries.map(([k, v]) => [k, encode(v)])) : EMPTY_OBJECT; }
  return value;
}
function decode(value: unknown): unknown {
  if (isTag(value, "null")) return null; if (isTag(value, "empty_array")) return []; if (isTag(value, "empty_object")) return {};
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, decode(v)]));
  return value;
}
function isTag(value: unknown, tag: string) { return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && (value as Record<string, unknown>).__mangaPlanCodec === tag); }
