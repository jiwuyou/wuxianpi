export interface FloatingWindowGeometry {
  x: number;
  y: number;
  width: number;
  height?: number;
}

export interface FloatingWindowViewport {
  width: number;
  height: number;
}

export type FloatingWindowMethod = "select" | "confirm" | "input" | "editor";

interface StoredFloatingWindowGeometry {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightMode: "auto" | "ratio";
  heightRatio?: number;
}

const TITLE_VISIBLE_PX = 48;
const RECOVERY_TOP_RATIO = 0.06;

export function floatingWindowWidthLimits(
  viewportWidth: number,
  viewportHeight = viewportWidth,
): { min: number; max: number; initial: number } {
  const mobile = Math.min(viewportWidth, viewportHeight) <= 640;
  return {
    min: viewportWidth * (mobile ? 0.6 : 0.28),
    max: viewportWidth * (mobile ? 0.96 : 0.92),
    initial: viewportWidth * (mobile ? 0.92 : 0.56),
  };
}

export function defaultFloatingWindowGeometry(
  viewport: FloatingWindowViewport,
  offset = 0,
  method: FloatingWindowMethod = "confirm",
): FloatingWindowGeometry {
  const ratios = defaultRatios(viewport, method);
  const stagger = Math.min(offset, 4) * 24;
  return clampFloatingWindowGeometry({
    x: viewport.width * ratios.xRatio + stagger,
    y: viewport.height * ratios.yRatio + stagger,
    width: viewport.width * ratios.widthRatio,
    ...(ratios.heightMode === "ratio" && ratios.heightRatio
      ? { height: viewport.height * ratios.heightRatio }
      : {}),
  }, viewport);
}

export function clampFloatingWindowGeometry(
  geometry: FloatingWindowGeometry,
  viewport: FloatingWindowViewport,
  measuredHeight?: number,
): FloatingWindowGeometry {
  const limits = floatingWindowWidthLimits(viewport.width, viewport.height);
  const width = clamp(geometry.width, limits.min, limits.max);
  const height = geometry.height && geometry.height > 0 ? geometry.height : undefined;
  const visibleHeight = height ?? measuredHeight ?? TITLE_VISIBLE_PX;
  const minX = -(width - TITLE_VISIBLE_PX);
  const maxX = viewport.width - TITLE_VISIBLE_PX;
  const minY = -(visibleHeight - TITLE_VISIBLE_PX);
  const maxY = viewport.height - TITLE_VISIBLE_PX;
  return {
    x: clamp(geometry.x, minX, maxX),
    y: clamp(geometry.y, minY, maxY),
    width,
    ...(height ? { height } : {}),
  };
}

export function floatingWindowNeedsRecovery(
  geometry: FloatingWindowGeometry,
  viewport: FloatingWindowViewport,
): boolean {
  return geometry.x < 0 || geometry.y < 0 ||
    geometry.x + geometry.width > viewport.width ||
    geometry.y + TITLE_VISIBLE_PX > viewport.height;
}

export function recoverFloatingWindowGeometry(
  geometry: FloatingWindowGeometry,
  viewport: FloatingWindowViewport,
): FloatingWindowGeometry {
  const clamped = clampFloatingWindowGeometry(geometry, viewport);
  return {
    ...clamped,
    x: Math.max(0, (viewport.width - clamped.width) / 2),
    y: Math.max(0, Math.min(viewport.height * RECOVERY_TOP_RATIO, viewport.height - TITLE_VISIBLE_PX)),
  };
}

export function rescaleFloatingWindowGeometry(
  geometry: FloatingWindowGeometry,
  previousViewport: FloatingWindowViewport,
  nextViewport: FloatingWindowViewport,
): FloatingWindowGeometry {
  return geometryFromRatios(geometryRatios(geometry, previousViewport), nextViewport);
}

export function geometryStorageValue(geometry: FloatingWindowGeometry, viewport: FloatingWindowViewport): string {
  return JSON.stringify(geometryRatios(geometry, viewport));
}

export function geometryFromStorage(value: string | null, viewport: FloatingWindowViewport): FloatingWindowGeometry | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!isStoredGeometry(parsed)) return null;
    return geometryFromRatios(parsed, viewport);
  } catch {
    return null;
  }
}

function defaultRatios(viewport: FloatingWindowViewport, method: FloatingWindowMethod): StoredFloatingWindowGeometry {
  const landscape = viewport.width > viewport.height;
  if (Math.min(viewport.width, viewport.height) <= 640) {
    const widthRatio = landscape ? 0.84 : 0.92;
    const xRatio = landscape ? 0.08 : 0.04;
    if (method === "input") return { xRatio, yRatio: 0.12, widthRatio, heightMode: "auto" };
    return {
      xRatio,
      yRatio: method === "select" ? 0.08 : 0.06,
      widthRatio,
      heightMode: "ratio",
      heightRatio: method === "select" ? (landscape ? 0.66 : 0.56) : (landscape ? 0.78 : 0.72),
    };
  }
  if (viewport.width <= 1024) {
    if (method === "input") return { xRatio: 0.1, yRatio: 0.12, widthRatio: 0.8, heightMode: "auto" };
    return {
      xRatio: 0.1,
      yRatio: 0.08,
      widthRatio: 0.8,
      heightMode: "ratio",
      heightRatio: method === "select" ? 0.6 : 0.72,
    };
  }
  if (method === "input") return { xRatio: 0.22, yRatio: 0.12, widthRatio: 0.56, heightMode: "auto" };
  return {
    xRatio: 0.22,
    yRatio: 0.1,
    widthRatio: 0.56,
    heightMode: "ratio",
    heightRatio: method === "select" ? 0.58 : 0.68,
  };
}

function geometryRatios(
  geometry: FloatingWindowGeometry,
  viewport: FloatingWindowViewport,
): StoredFloatingWindowGeometry {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  return {
    xRatio: geometry.x / width,
    yRatio: geometry.y / height,
    widthRatio: geometry.width / width,
    heightMode: geometry.height ? "ratio" : "auto",
    ...(geometry.height ? { heightRatio: geometry.height / height } : {}),
  };
}

function geometryFromRatios(
  stored: StoredFloatingWindowGeometry,
  viewport: FloatingWindowViewport,
): FloatingWindowGeometry {
  return clampFloatingWindowGeometry({
    x: stored.xRatio * viewport.width,
    y: stored.yRatio * viewport.height,
    width: stored.widthRatio * viewport.width,
    ...(stored.heightMode === "ratio" && stored.heightRatio
      ? { height: stored.heightRatio * viewport.height }
      : {}),
  }, viewport);
}

function isStoredGeometry(value: Record<string, unknown>): value is Record<string, unknown> & StoredFloatingWindowGeometry {
  const finite = (item: unknown) => typeof item === "number" && Number.isFinite(item);
  if (![value.xRatio, value.yRatio, value.widthRatio].every(finite)) return false;
  if (Number(value.widthRatio) <= 0) return false;
  if (value.heightMode === "auto") return value.heightRatio === undefined;
  return value.heightMode === "ratio" && finite(value.heightRatio) && Number(value.heightRatio) > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
