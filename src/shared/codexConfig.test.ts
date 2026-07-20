import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeCodexConfigToml } from "./codexConfig.js";

test("removes the unsupported default service tier", () => {
  const result = sanitizeCodexConfigToml('notify = []\r\nservice_tier = "default" # standard speed\r\n\r\n[windows]\r\nsandbox = "elevated"\r\n');

  assert.equal(result.removedServiceTier, "default");
  assert.equal(result.content, 'notify = []\r\n\r\n[windows]\r\nsandbox = "elevated"\r\n');
});

test("removes an unknown or malformed top-level service tier", () => {
  const result = sanitizeCodexConfigToml("service_tier = standard # unsupported\nmodel = \"gpt-5.5\"\n");

  assert.equal(result.removedServiceTier, "standard");
  assert.equal(result.content, 'model = "gpt-5.5"\n');
});

test("preserves supported service tiers", () => {
  const fastConfig = 'service_tier = "fast"\n';
  const flexConfig = "service_tier = 'flex'\n";

  assert.deepEqual(sanitizeCodexConfigToml(fastConfig), { content: fastConfig });
  assert.deepEqual(sanitizeCodexConfigToml(flexConfig), { content: flexConfig });
});

test("does not change service_tier inside a TOML table", () => {
  const config = '[profiles.legacy]\nservice_tier = "default"\n';

  assert.deepEqual(sanitizeCodexConfigToml(config), { content: config });
});

test("still sanitizes a top-level service tier after a multiline array", () => {
  const config = 'notify = [\n  "command",\n  "turn-ended"\n]\nservice_tier = "default"\n';

  assert.deepEqual(sanitizeCodexConfigToml(config), {
    content: 'notify = [\n  "command",\n  "turn-ended"\n]\n',
    removedServiceTier: "default"
  });
});

test("leaves a config without service_tier unchanged", () => {
  const config = 'notify = []\n\n[windows]\nsandbox = "elevated"\n';

  assert.deepEqual(sanitizeCodexConfigToml(config), { content: config });
});
