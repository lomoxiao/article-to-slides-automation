import { chromium, type Browser } from "playwright";
import { convertJsonToSvgBatchViaGas } from "./gasSlides.js";
import { collectChartTargets } from "./chartData.js";
import { clampSvgSize, createSvgRenderHtml, parseSvgSize } from "./chartSvg.js";

// チャート描画の I/O オーケストレーション(GAS で JSON→SVG、Playwright で SVG→PNG)。
// 対象抽出・スキーマ検証は chartData.ts、SVG サイズ解決は chartSvg.ts(いずれも純粋ロジック)。

type SlideLike = {
  image?: unknown;
};

const SVG_RENDER_TIMEOUT_MS = 10_000;

export async function renderChartImagesInSlideData(slideData: unknown[]): Promise<unknown[]> {
  const clonedSlideData = structuredCloneJson(slideData);
  const targets = collectChartTargets(clonedSlideData);

  if (targets.length === 0) {
    return clonedSlideData;
  }

  const startedAt = Date.now();
  const uniqueKeys = [...new Set(targets.map((target) => target.key))];
  console.log(`Rendering ${targets.length} chart image(s), ${uniqueKeys.length} unique chart JSON payload(s).`);

  const svgItems = await convertJsonToSvgBatchViaGas(uniqueKeys);
  const svgByKey = new Map<string, string>();

  for (const item of svgItems) {
    if (!item.svg) {
      const matchingTarget = targets.find((target) => target.key === item.key);
      const slideText = matchingTarget ? `slide ${matchingTarget.slideIndex + 1}` : "unknown slide";
      const chartTypeText = matchingTarget ? `chartType ${matchingTarget.chartType}` : "unknown chartType";
      throw new Error(
        `GAS SVG conversion failed for ${slideText} (${chartTypeText}): ${item.error ?? "missing svg"}`
      );
    }

    svgByKey.set(item.key, item.svg);
  }

  for (const key of uniqueKeys) {
    if (!svgByKey.has(key)) {
      const matchingTarget = targets.find((target) => target.key === key);
      const slideText = matchingTarget ? `slide ${matchingTarget.slideIndex + 1}` : "unknown slide";
      const chartTypeText = matchingTarget ? `chartType ${matchingTarget.chartType}` : "unknown chartType";
      throw new Error(`GAS SVG conversion did not return a result for ${slideText} (${chartTypeText}).`);
    }
  }

  let browser: Browser | undefined;
  const pngByKey = new Map<string, string>();

  try {
    browser = await chromium.launch({ headless: true });

    for (const key of uniqueKeys) {
      const svg = svgByKey.get(key);
      if (!svg) {
        continue;
      }

      const matchingTarget = targets.find((target) => target.key === key);

      try {
        pngByKey.set(key, await renderSvgToPngDataUrl(browser, svg));
      } catch (error) {
        const slideText = matchingTarget ? `slide ${matchingTarget.slideIndex + 1}` : "unknown slide";
        const chartTypeText = matchingTarget ? `chartType ${matchingTarget.chartType}` : "unknown chartType";
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`PNG rendering failed for ${slideText} ${chartTypeText}: ${message}`, { cause: error });
      }
    }
  } catch (error) {
    if (isPlaywrightChromiumInstallError(error)) {
      throw new Error("Playwright Chromium is not installed. Run: npx playwright install chromium", { cause: error });
    }

    throw error;
  } finally {
    await browser?.close();
  }

  for (const target of targets) {
    const pngDataUrl = pngByKey.get(target.key);

    if (!pngDataUrl) {
      throw new Error(`PNG rendering failed for slide ${target.slideIndex + 1} (${target.chartType}).`);
    }

    const slide = clonedSlideData[target.slideIndex] as SlideLike;
    slide.image = {
      info: "chart",
      data: pngDataUrl
    };
  }

  console.log(`Rendered chart images in ${Date.now() - startedAt}ms.`);
  return clonedSlideData;
}

async function renderSvgToPngDataUrl(browser: Browser, svg: string): Promise<string> {
  const size = parseSvgSize(svg);
  const page = await browser.newPage({
    viewport: {
      width: size.width,
      height: size.height
    }
  });

  page.setDefaultTimeout(SVG_RENDER_TIMEOUT_MS);

  try {
    await page.setContent(createSvgRenderHtml(svg), {
      waitUntil: "load",
      timeout: SVG_RENDER_TIMEOUT_MS
    });
    await page.waitForFunction(() => Boolean((window as unknown as { __svgRenderReady?: boolean }).__svgRenderReady), {
      timeout: SVG_RENDER_TIMEOUT_MS
    });

    const svgElement = await page.$("svg");
    if (!svgElement) {
      throw new Error("SVG element not found after rendering.");
    }

    const renderError = await svgElement.evaluate((element) => {
      const chartErrorPattern =
        /\u30b0\u30e9\u30d5\u63cf\u753b\u30a8\u30e9\u30fc|Chart Error|SyntaxError|TypeError|ReferenceError|Error:\s|Invalid JSON|JSON parse/i;
      const errorElement = element.querySelector(".error-message");
      const errorText = errorElement?.textContent?.trim();
      if (errorText && chartErrorPattern.test(errorText)) {
        return errorText;
      }

      return "";
    });

    if (renderError) {
      throw new Error(`Rendered SVG reported chart error: ${renderError}`);
    }

    const renderedSize = await svgElement.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height)
      };
    });
    const viewport = clampSvgSize(renderedSize.width, renderedSize.height);

    if (viewport.width !== size.width || viewport.height !== size.height) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(50);
    }

    const buffer = await svgElement.screenshot({
      type: "png",
      timeout: SVG_RENDER_TIMEOUT_MS
    });

    return `data:image/png;base64,${buffer.toString("base64")}`;
  } finally {
    await page.close();
  }
}

function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlaywrightChromiumInstallError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Executable doesn't exist") ||
    error.message.includes("playwright install") ||
    error.message.includes("browserType.launch")
  );
}
