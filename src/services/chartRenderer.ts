import { chromium, type Browser } from "playwright";
import { convertJsonToSvgBatchViaGas } from "./gasSlides.js";

type SlideLike = {
  image?: unknown;
};

type ChartImage = {
  chartType: string;
  data?: unknown;
};

type ChartTarget = {
  slideIndex: number;
  chartType: string;
  key: string;
};

type SvgSize = {
  width: number;
  height: number;
};

const SVG_RENDER_TIMEOUT_MS = 10_000;
const DEFAULT_SVG_SIZE: SvgSize = { width: 800, height: 600 };
const MAX_VIEWPORT_SIZE = 4096;

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
        throw new Error(`PNG rendering failed for ${slideText} ${chartTypeText}: ${message}`);
      }
    }
  } catch (error) {
    if (isPlaywrightChromiumInstallError(error)) {
      throw new Error("Playwright Chromium is not installed. Run: npx playwright install chromium");
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

function collectChartTargets(slideData: unknown[]): ChartTarget[] {
  const targets: ChartTarget[] = [];

  slideData.forEach((slide, slideIndex) => {
    if (!isRecord(slide)) {
      return;
    }

    const chartImage = parseChartImage(slide.image);
    if (!chartImage) {
      return;
    }

    validateChartImage(chartImage, slideIndex);

    targets.push({
      slideIndex,
      chartType: chartImage.chartType,
      key: chartImage.key
    });
  });

  return targets;
}

function parseChartImage(image: unknown): (ChartImage & { key: string }) | undefined {
  if (typeof image === "string") {
    const trimmed = image.trim();
    if (!trimmed.startsWith("{")) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (isChartImage(parsed)) {
        return { ...parsed, key: trimmed };
      }
    } catch {
      return undefined;
    }
  }

  if (isRecord(image) && image.info === "chart" && typeof image.data === "string" && image.data.startsWith("data:image/png")) {
    return undefined;
  }

  if (isChartImage(image)) {
    return { ...image, key: JSON.stringify(image) };
  }

  return undefined;
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

function createSvgRenderHtml(svg: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      overflow: hidden;
    }
    svg {
      display: block;
    }
  </style>
</head>
<body>
${svg}
<script>
  setTimeout(function () {
    window.__svgRenderReady = true;
  }, 0);
</script>
</body>
</html>`;
}

function parseSvgSize(svg: string): SvgSize {
  const width = parseSvgLength(readSvgAttribute(svg, "width"));
  const height = parseSvgLength(readSvgAttribute(svg, "height"));

  if (width && height) {
    return clampSvgSize(width, height);
  }

  const viewBox = readSvgAttribute(svg, "viewBox");
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return clampSvgSize(Math.ceil(parts[2]), Math.ceil(parts[3]));
    }
  }

  return DEFAULT_SVG_SIZE;
}

function readSvgAttribute(svg: string, name: string): string | undefined {
  const match = svg.match(new RegExp(`<svg\\b[^>]*\\s${name}=["']([^"']+)["']`, "i"));
  return match?.[1];
}

function parseSvgLength(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)/);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : undefined;
}

function clampSvgSize(width: number, height: number): SvgSize {
  return {
    width: Math.min(Math.max(Math.ceil(width) || DEFAULT_SVG_SIZE.width, 1), MAX_VIEWPORT_SIZE),
    height: Math.min(Math.max(Math.ceil(height) || DEFAULT_SVG_SIZE.height, 1), MAX_VIEWPORT_SIZE)
  };
}

function isChartImage(value: unknown): value is ChartImage {
  return isRecord(value) && typeof value.chartType === "string" && value.chartType.trim().length > 0;
}

function validateChartImage(chartImage: ChartImage, slideIndex: number) {
  const chartType = chartImage.chartType.trim();
  const context = `slide ${slideIndex + 1} chartType ${chartType}`;
  const data = getRequiredRecord(chartImage, "data", context);

  switch (chartType) {
    case "bar":
      validateNoUnsupportedKeys(data, context, ["xKey", "yLabel", "bars"]);
      validateItems(data, context, "items", ["label", "value"]);
      validateColor(data, context, ["start", "end"]);
      validateLayout(data, context);
      validateNumberRecord(data, context, "barOptions", ["barToSlotRatio"]);
      validateNumberRecord(data, context, "yAxis", ["max", "min", "tickCount"]);
      return;

    case "line":
      validateNoUnsupportedKeys(data, context, ["xKey", "yLabel", "lines"]);
      getRequiredString(data, "yAxisUnitLabel", context);
      validateItems(data, context, "items", ["label", "value"]);
      validateColor(data, context, ["start", "end", "line", "label"]);
      validateLayout(data, context);
      validateNumberRecord(data, context, "yAxis", ["max", "min", "tickCount"]);
      validateNumberRecord(data, context, "lineOptions", [
        "markerRadius",
        "dataLabelOffsetY",
        "horizontalPadding"
      ]);
      return;

    case "donut":
      getRequiredString(data, "centerLabel", context);
      validateItems(data, context, "items", ["label", "value", "id"]);
      validateIdColors(data, context);
      return;

    case "multi-line":
      validateStringArray(data, context, "xAxisLabels");
      validateItems(data, context, "series", ["id", "label", "values"]);
      validateSeriesValues(data, context, "series", "xAxisLabels");
      validateIdColors(data, context);
      validateNumberRecord(data, context, "yAxis", ["max", "min", "tickCount"]);
      return;

    case "stacked-bar":
      validateStringArray(data, context, "legendLabels");
      validateStackedBarData(data, context);
      validateIdColors(data, context);
      validateNumberRecord(data, context, "yAxis", ["max", "min", "tickCount"]);
      return;

    case "100-stacked-bar":
      validateStringArray(data, context, "legendLabels");
      validateStackedBarData(data, context);
      validateIdColors(data, context);
      validateNumberRecord(data, context, "yAxis", ["tickCount"]);
      return;

    case "combo":
      getRequiredString(data, "legendBarLabel", context);
      getRequiredString(data, "legendLineLabel", context);
      getRequiredString(data, "yAxisLeftLabel", context);
      getRequiredString(data, "yAxisRightLabel", context);
      validateItems(data, context, "items", ["label", "barValue", "lineValue"]);
      validateComboColors(data, context);
      validateNumberRecord(data, context, "yAxisLeft", ["max", "min", "tickCount"]);
      validateNumberRecord(data, context, "yAxisRight", ["max", "min", "tickCount"]);
      return;

    default:
      throw new Error(`${context}: unsupported chartType`);
  }
}

function validateNoUnsupportedKeys(data: Record<string, unknown>, context: string, keys: string[]) {
  for (const key of keys) {
    if (key in data) {
      throw new Error(`${context}: unsupported data.${key}; use the Majin template schema`);
    }
  }
}

function validateItems(
  data: Record<string, unknown>,
  context: string,
  key: string,
  requiredFields: string[]
) {
  const items = getRequiredArray(data, key, context);

  items.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${context}: data.${key}[${index}] must be an object`);
    }

    for (const field of requiredFields) {
      const path = `data.${key}[${index}].${field}`;
      if (!(field in item)) {
        throw new Error(`${context}: missing ${path}`);
      }

      if (field === "value" || field === "barValue" || field === "lineValue") {
        requireFiniteNumber(item[field], context, path);
      } else if (field === "values") {
        requireNumberArray(item[field], context, path);
      } else {
        requireNonEmptyString(item[field], context, path);
      }
    }
  });
}

function validateColor(data: Record<string, unknown>, context: string, requiredFields: string[]) {
  const color = getRequiredRecord(data, "color", context);
  for (const field of requiredFields) {
    getRequiredString(color, field, context, "data.color");
  }
}

function validateIdColors(data: Record<string, unknown>, context: string) {
  const colors = getRequiredArray(data, "colors", context);
  const colorIds = new Set<string>();

  colors.forEach((color, index) => {
    if (!isRecord(color)) {
      throw new Error(`${context}: data.colors[${index}] must be an object`);
    }

    const id = getRequiredString(color, "id", context, `data.colors[${index}]`);
    getRequiredString(color, "start", context, `data.colors[${index}]`);
    getRequiredString(color, "end", context, `data.colors[${index}]`);
    colorIds.add(id);
  });

  const itemCollections = [
    ["items", data.items],
    ["series", data.series]
  ] as const;

  for (const [key, value] of itemCollections) {
    if (!Array.isArray(value)) {
      continue;
    }

    value.forEach((item, index) => {
      if (!isRecord(item)) {
        return;
      }

      const id = item.id;
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new Error(`${context}: missing data.${key}[${index}].id`);
      }

      if (!colorIds.has(id)) {
        throw new Error(`${context}: data.${key}[${index}].id does not match any data.colors[].id`);
      }
    });
  }
}

function validateLayout(data: Record<string, unknown>, context: string) {
  validateNumberRecord(data, context, "layout", [
    "width",
    "height",
    "marginTop",
    "marginBottom",
    "marginLeft",
    "marginRight"
  ]);
}

function validateNumberRecord(
  data: Record<string, unknown>,
  context: string,
  key: string,
  requiredFields: string[]
) {
  const record = getRequiredRecord(data, key, context);
  for (const field of requiredFields) {
    getRequiredNumber(record, field, context, `data.${key}`);
  }
}

function validateStringArray(data: Record<string, unknown>, context: string, key: string) {
  const values = getRequiredArray(data, key, context);
  values.forEach((value, index) => {
    requireNonEmptyString(value, context, `data.${key}[${index}]`);
  });
}

function validateSeriesValues(data: Record<string, unknown>, context: string, seriesKey: string, labelsKey: string) {
  const series = getRequiredArray(data, seriesKey, context);
  const labels = getRequiredArray(data, labelsKey, context);

  series.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${context}: data.${seriesKey}[${index}] must be an object`);
    }

    if (!Array.isArray(item.values) || item.values.length !== labels.length) {
      throw new Error(`${context}: data.${seriesKey}[${index}].values must match data.${labelsKey}.length`);
    }
  });
}

function validateStackedBarData(data: Record<string, unknown>, context: string) {
  const legendLabels = getRequiredArray(data, "legendLabels", context);
  const barData = getRequiredArray(data, "barData", context);

  barData.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${context}: data.barData[${index}] must be an object`);
    }

    getRequiredString(item, "label", context, `data.barData[${index}]`);
    const values = getRequiredArray(item, "values", context, `data.barData[${index}]`);
    values.forEach((value, valueIndex) => {
      requireFiniteNumber(value, context, `data.barData[${index}].values[${valueIndex}]`);
    });

    if (values.length !== legendLabels.length) {
      throw new Error(`${context}: data.barData[${index}].values must match data.legendLabels.length`);
    }
  });
}

function validateComboColors(data: Record<string, unknown>, context: string) {
  const colors = getRequiredRecord(data, "colors", context);
  const bar = getRequiredRecord(colors, "bar", context, "data.colors");
  getRequiredString(bar, "start", context, "data.colors.bar");
  getRequiredString(bar, "end", context, "data.colors.bar");
  getRequiredString(colors, "line", context, "data.colors");
}

function getRequiredRecord(
  value: Record<string, unknown>,
  key: string,
  context: string,
  parentPath = "data"
): Record<string, unknown> {
  const child = value[key];
  if (!isRecord(child)) {
    throw new Error(`${context}: missing ${parentPath}.${key}`);
  }

  return child;
}

function getRequiredArray(value: Record<string, unknown>, key: string, context: string, parentPath = "data") {
  const child = value[key];
  if (!Array.isArray(child) || child.length === 0) {
    throw new Error(`${context}: missing ${parentPath}.${key}`);
  }

  return child;
}

function getRequiredString(value: Record<string, unknown>, key: string, context: string, parentPath = "data") {
  const child = value[key];
  const path = `${parentPath}.${key}`;
  requireNonEmptyString(child, context, path);
  return child as string;
}

function getRequiredNumber(value: Record<string, unknown>, key: string, context: string, parentPath = "data") {
  const child = value[key];
  const path = `${parentPath}.${key}`;
  requireFiniteNumber(child, context, path);
  return child as number;
}

function requireNumberArray(value: unknown, context: string, path: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context}: missing ${path}`);
  }

  value.forEach((item, index) => {
    requireFiniteNumber(item, context, `${path}[${index}]`);
  });
}

function requireNonEmptyString(value: unknown, context: string, path: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}: missing ${path}`);
  }
}

function requireFiniteNumber(value: unknown, context: string, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}: missing ${path}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

