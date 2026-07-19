import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MANGA_ART_STYLE,
  DEFAULT_MANGA_PAGES,
  DEFAULT_MANGA_TREATMENT,
  parseMangaSlackArgs
} from "./parseMangaSlackArgs.js";

test("bare URL after /manga uses defaults", () => {
  const result = parseMangaSlackArgs("/manga https://a.com/article");
  assert.ok(result.ok);
  assert.equal(result.url, "https://a.com/article");
  assert.equal(result.pages, DEFAULT_MANGA_PAGES);
  assert.equal(result.artStyle, DEFAULT_MANGA_ART_STYLE);
  assert.equal(result.treatment, DEFAULT_MANGA_TREATMENT);
});

test("[manga-generate] with explicit flags", () => {
  const result = parseMangaSlackArgs("[manga-generate] --url https://a.com --pages 7 --art-style A");
  assert.ok(result.ok);
  assert.equal(result.url, "https://a.com");
  assert.equal(result.pages, 7);
  assert.equal(result.artStyle, "A");
});

test("--url strips Slack link decoration", () => {
  const result = parseMangaSlackArgs("--url <https://a.com/x>");
  assert.ok(result.ok);
  assert.equal(result.url, "https://a.com/x");
});

test("lowercase art-style and treatment are upcased", () => {
  const result = parseMangaSlackArgs("--url https://a.com --art-style b --treatment a");
  assert.ok(result.ok);
  assert.equal(result.artStyle, "B");
  assert.equal(result.treatment, "A");
});

test("quoted --genre keeps inner spaces", () => {
  const result = parseMangaSlackArgs('--url https://a.com --genre "SF コメディ"');
  assert.ok(result.ok);
  assert.equal(result.genre, "SF コメディ");
});

test("zero --pages is rejected", () => {
  const result = parseMangaSlackArgs("--url https://a.com --pages 0");
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "--pages には正の整数（総見開き数）を指定してください");
});

test("invalid art-style is rejected", () => {
  const result = parseMangaSlackArgs("--url https://a.com --art-style Z");
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "--art-style は A〜G のいずれかを指定してください");
});

test("invalid treatment is rejected", () => {
  const result = parseMangaSlackArgs("--url https://a.com --treatment D");
  assert.ok(!result.ok);
  assert.equal(
    result.errorMessage,
    "--treatment は A（原作忠実）/ B（脚色）/ C（完全創作）のいずれかを指定してください"
  );
});

test("missing URL is rejected", () => {
  const result = parseMangaSlackArgs("--pages 5");
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "`--url` に http(s) の URL を指定してください");
});

test("unsupported flag is rejected", () => {
  const result = parseMangaSlackArgs("--url https://a.com --style A");
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, "未対応の引数です: --style");
});
