import { config } from "../config.js";

export type GasSlidesResult = {
  ok: boolean;
  url?: string;
  presentationId?: string | null;
  error?: string;
};

export async function createSlidesViaGas(slideData: unknown[]): Promise<GasSlidesResult> {
  if (!config.GAS_WEB_APP_URL) {
    throw new Error("GAS_WEB_APP_URL is not set in .env");
  }

  const response = await fetch(config.GAS_WEB_APP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      slideData,
      settings: {
        driveFolderId: config.GOOGLE_DRIVE_FOLDER_ID
      }
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`GAS request failed: ${response.status} ${response.statusText}\n${text}`);
  }

  const result = JSON.parse(text) as GasSlidesResult;
  if (!result.ok) {
    throw new Error(result.error ?? "GAS returned an unknown error");
  }

  return result;
}
