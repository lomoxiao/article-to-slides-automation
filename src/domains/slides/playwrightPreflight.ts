import { chromium, type Browser } from "playwright";

export const PLAYWRIGHT_CHROMIUM_UNAVAILABLE = "PLAYWRIGHT_CHROMIUM_UNAVAILABLE";
export const PLAYWRIGHT_PUBLIC_STATUS_MESSAGE =
  "Google\u30b9\u30e9\u30a4\u30c9\u751f\u6210\u74b0\u5883\u3092\u6e96\u5099\u3067\u304d\u3066\u3044\u307e\u305b\u3093\u3002\u7ba1\u7406\u8005\u3078\u304a\u554f\u3044\u5408\u308f\u305b\u304f\u3060\u3055\u3044\u3002";

export type SlidesRuntimeReadiness =
  | { status: "available"; checkedAt: string }
  | { status: "unavailable"; checkedAt: string; code: typeof PLAYWRIGHT_CHROMIUM_UNAVAILABLE; detail: string };

type BrowserLauncher = () => Promise<Browser>;

let currentReadiness: SlidesRuntimeReadiness = {
  status: "unavailable",
  checkedAt: new Date(0).toISOString(),
  code: PLAYWRIGHT_CHROMIUM_UNAVAILABLE,
  detail: "Playwright Chromium has not been checked"
};

export class SlidesRuntimeUnavailableError extends Error {
  readonly code = PLAYWRIGHT_CHROMIUM_UNAVAILABLE;
  readonly detail?: string;

  constructor(detail?: string, options?: ErrorOptions) {
    super(PLAYWRIGHT_PUBLIC_STATUS_MESSAGE, options);
    this.name = "SlidesRuntimeUnavailableError";
    this.detail = detail;
  }
}

export async function probePlaywrightChromium(
  launch: BrowserLauncher = () => chromium.launch({ headless: true })
): Promise<SlidesRuntimeReadiness> {
  const checkedAt = new Date().toISOString();
  let browser: Browser | undefined;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 32, height: 32 } });
    try {
      await page.setContent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#2563eb"/></svg>');
      const png = await page.screenshot({ type: "png" });
      if (png.length < 8 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("Playwright screenshot did not produce a PNG");
      }
    } finally {
      await page.close();
    }
    return { status: "available", checkedAt };
  } catch (error) {
    return {
      status: "unavailable",
      checkedAt,
      code: PLAYWRIGHT_CHROMIUM_UNAVAILABLE,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function refreshSlidesRuntimeReadiness(): Promise<SlidesRuntimeReadiness> {
  currentReadiness = await probePlaywrightChromium();
  return currentReadiness;
}

export async function ensureSlidesRuntimeReady(): Promise<void> {
  if (currentReadiness.status === "available") return;
  const retried = await refreshSlidesRuntimeReadiness();
  if (retried.status === "unavailable") {
    throw new SlidesRuntimeUnavailableError(retried.detail);
  }
}

export function isPlaywrightChromiumUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error instanceof SlidesRuntimeUnavailableError ||
    error.message.includes("Executable doesn't exist") ||
    error.message.includes("playwright install") ||
    error.message.includes("browserType.launch");
}

export function isSlidesRuntimeUnavailableError(error: unknown): boolean {
  return error instanceof SlidesRuntimeUnavailableError ||
    (typeof error === "object" && error !== null && "code" in error &&
      (error as { code?: unknown }).code === PLAYWRIGHT_CHROMIUM_UNAVAILABLE);
}
