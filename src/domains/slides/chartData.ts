// スライドデータからのチャート対象抽出と、Majin テンプレートスキーマに対する
// チャート JSON の検証(純粋ロジック)。SVG/PNG への描画は chartRenderer.ts 側の責務。

export type ChartImage = {
  chartType: string;
  data?: unknown;
};

export type ChartTarget = {
  slideIndex: number;
  chartType: string;
  key: string;
};

type SlideLike = {
  image?: unknown;
};

export function collectChartTargets(slideData: unknown[]): ChartTarget[] {
  const targets: ChartTarget[] = [];

  slideData.forEach((slide, slideIndex) => {
    if (!isRecord(slide)) {
      return;
    }

    const chartImage = parseChartImage((slide as SlideLike).image);
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

export function parseChartImage(image: unknown): (ChartImage & { key: string }) | undefined {
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

function isChartImage(value: unknown): value is ChartImage {
  return isRecord(value) && typeof value.chartType === "string" && value.chartType.trim().length > 0;
}

export function validateChartImage(chartImage: ChartImage, slideIndex: number) {
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
