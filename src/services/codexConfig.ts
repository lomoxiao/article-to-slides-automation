import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPPORTED_SERVICE_TIERS = new Set(["fast", "flex"]);

export type SanitizedCodexConfig = {
  content: string;
  removedServiceTier?: string;
};

export type CopyCodexConfigResult = {
  copied: boolean;
  removedServiceTier?: string;
};

export function sanitizeCodexConfigToml(content: string): SanitizedCodexConfig {
  const lines = content.match(/.*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  let atTopLevel = true;
  let removedServiceTier: string | undefined;

  const sanitizedLines = lines.filter((line) => {
    const lineWithoutEnding = line.replace(/(?:\r\n|\n)$/, "");
    const trimmed = lineWithoutEnding.trimStart();

    if (atTopLevel && /^\[\[?.+\]\]?(?:\s*#.*)?$/.test(trimmed)) {
      atTopLevel = false;
    }

    if (!atTopLevel || !/^(?:service_tier|"service_tier")\s*=/.test(trimmed)) {
      return true;
    }

    const valueMatch = trimmed.match(/^(?:service_tier|"service_tier")\s*=\s*["']([^"']*)["']/);
    const value = valueMatch?.[1];
    if (value && SUPPORTED_SERVICE_TIERS.has(value)) {
      return true;
    }

    removedServiceTier = value ?? trimmed.slice(trimmed.indexOf("=") + 1).split("#", 1)[0].trim();
    return false;
  });

  return {
    content: sanitizedLines.join(""),
    ...(removedServiceTier !== undefined ? { removedServiceTier } : {})
  };
}

export async function copySanitizedCodexConfig(source: string, destination: string): Promise<CopyCodexConfigResult> {
  if (!existsSync(source)) {
    return { copied: false };
  }

  const sourceContent = await readFile(source, "utf8");
  const sanitized = sanitizeCodexConfigToml(sourceContent);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, sanitized.content, "utf8");

  return {
    copied: true,
    ...(sanitized.removedServiceTier !== undefined ? { removedServiceTier: sanitized.removedServiceTier } : {})
  };
}
