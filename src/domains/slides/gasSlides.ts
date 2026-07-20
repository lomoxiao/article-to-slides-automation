import { config } from "../../config.js";

export type GasSlidesResult = {
  ok: boolean;
  url?: string;
  presentationId?: string | null;
  linkSummary?: {
    linkedCount: number;
    skippedCount?: number;
    error?: string;
  };
  error?: string;
};

export type GasSvgConversionItem = {
  key: string;
  svg?: string;
  error?: string;
};

export type GasSvgConversionResult = {
  ok: boolean;
  results?: GasSvgConversionItem[];
  error?: string;
};

const GAS_REQUEST_TIMEOUT_MS = 330_000;

export async function createSlidesViaGas(slideData: unknown[]): Promise<GasSlidesResult> {
  const result = await postGas<GasSlidesResult>({
    slideData,
    settings: {
      driveFolderId: config.GOOGLE_DRIVE_FOLDER_ID
    }
  });

  if (!result.ok) {
    throw new Error(result.error ?? "GAS returned an unknown error");
  }

  return result;
}

export async function convertJsonToSvgBatchViaGas(
  jsonStrings: string[]
): Promise<GasSvgConversionItem[]> {
  const result = await postGas<GasSvgConversionResult>({
    action: "convertJsonToSvgBatch",
    jsonStrings
  });

  if (!result.ok) {
    throw new Error(result.error ?? "GAS returned an unknown SVG conversion error");
  }

  if (!Array.isArray(result.results)) {
    throw new Error("GAS SVG conversion response did not include a results array.");
  }

  return result.results;
}

async function postGas<T>(body: unknown): Promise<T> {
  if (!config.GAS_WEB_APP_URL) {
    throw new Error("GAS_WEB_APP_URL is not set in .env");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GAS_REQUEST_TIMEOUT_MS);

  const response = await fetch(config.GAS_WEB_APP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`GAS request failed: ${response.status} ${response.statusText}\n${text}`);
  }

  return JSON.parse(text) as T;
}
