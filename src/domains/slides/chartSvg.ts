// SVG 文字列のサイズ解決とレンダリング用 HTML 生成(純粋ロジック)。
// Playwright での実描画は chartRenderer.ts 側の責務。

export type SvgSize = {
  width: number;
  height: number;
};

const DEFAULT_SVG_SIZE: SvgSize = { width: 800, height: 600 };
const MAX_VIEWPORT_SIZE = 4096;

export function parseSvgSize(svg: string): SvgSize {
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

export function clampSvgSize(width: number, height: number): SvgSize {
  return {
    width: Math.min(Math.max(Math.ceil(width) || DEFAULT_SVG_SIZE.width, 1), MAX_VIEWPORT_SIZE),
    height: Math.min(Math.max(Math.ceil(height) || DEFAULT_SVG_SIZE.height, 1), MAX_VIEWPORT_SIZE)
  };
}

export function createSvgRenderHtml(svg: string) {
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
