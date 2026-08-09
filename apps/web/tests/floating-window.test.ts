import { describe, expect, it } from "vitest";
import {
  clampFloatingWindowGeometry,
  defaultFloatingWindowGeometry,
  floatingWindowNeedsRecovery,
  floatingWindowWidthLimits,
  geometryFromStorage,
  geometryStorageValue,
  recoverFloatingWindowGeometry,
  rescaleFloatingWindowGeometry,
} from "../src/lib/floating-window";

describe("floating extension window geometry", () => {
  it("uses viewport percentage width limits in portrait and landscape", () => {
    const portrait = floatingWindowWidthLimits(390, 844);
    expect(portrait.min).toBeCloseTo(234);
    expect(portrait.max).toBeCloseTo(374.4);
    expect(portrait.initial).toBeCloseTo(358.8);

    const landscape = floatingWindowWidthLimits(844, 390);
    expect(landscape.min).toBeCloseTo(506.4);
    expect(landscape.max).toBeCloseTo(810.24);

    const desktop = floatingWindowWidthLimits(1200, 900);
    expect(desktop.min).toBeCloseTo(336);
    expect(desktop.max).toBeCloseTo(1104);
    expect(desktop.initial).toBeCloseTo(672);
  });

  it("uses percentage defaults that keep the mobile bottom edge high", () => {
    const confirm = defaultFloatingWindowGeometry({ width: 390, height: 844 }, 0, "confirm");
    expect(confirm.x).toBeCloseTo(15.6);
    expect(confirm.y).toBeCloseTo(50.64);
    expect(confirm.width).toBeCloseTo(358.8);
    expect(confirm.height).toBeCloseTo(607.68);
    expect((confirm.y + (confirm.height ?? 0)) / 844).toBeCloseTo(0.78);

    const input = defaultFloatingWindowGeometry({ width: 390, height: 844 }, 0, "input");
    expect(input.height).toBeUndefined();
  });

  it("keeps a recoverable part of the window visible", () => {
    const clamped = clampFloatingWindowGeometry({ x: -1000, y: 1000, width: 700, height: 500 }, { width: 800, height: 600 });
    expect(clamped.x).toBe(-652);
    expect(clamped.y).toBe(552);
    expect(clamped.width).toBe(700);
  });

  it("detects when the title bar or window width leaves the viewport", () => {
    const viewport = { width: 800, height: 600 };
    expect(floatingWindowNeedsRecovery({ x: 20, y: 20, width: 600 }, viewport)).toBe(false);
    expect(floatingWindowNeedsRecovery({ x: 20, y: -1, width: 600 }, viewport)).toBe(true);
    expect(floatingWindowNeedsRecovery({ x: -20, y: 20, width: 600 }, viewport)).toBe(true);
  });

  it("recovers the full title bar without changing the window size", () => {
    const recovered = recoverFloatingWindowGeometry(
      { x: -500, y: -420, width: 700, height: 500 },
      { width: 800, height: 600 },
    );
    expect(recovered).toEqual({ x: 50, y: 36, width: 700, height: 500 });
  });

  it("stores and restores every explicit dimension as a percentage", () => {
    const firstViewport = { width: 1000, height: 800 };
    const stored = geometryStorageValue({ x: 100, y: 80, width: 560, height: 400 }, firstViewport);
    expect(JSON.parse(stored)).toEqual({
      xRatio: 0.1,
      yRatio: 0.1,
      widthRatio: 0.56,
      heightMode: "ratio",
      heightRatio: 0.5,
    });
    expect(geometryFromStorage(stored, { width: 500, height: 400 })).toMatchObject({
      x: 50,
      y: 40,
      width: 300,
      height: 200,
    });
  });

  it("rejects the previous pixel-height storage shape", () => {
    expect(geometryFromStorage(JSON.stringify({
      xRatio: 0.1,
      yRatio: 0.1,
      widthRatio: 0.56,
      height: 400,
    }), { width: 500, height: 400 })).toBeNull();
  });

  it("rescales the current geometry instead of reloading stored pixels", () => {
    const resized = rescaleFloatingWindowGeometry(
      { x: 40, y: 60, width: 360, height: 600 },
      { width: 400, height: 800 },
      { width: 800, height: 400 },
    );
    expect(resized).toMatchObject({ x: 80, y: 30, width: 720, height: 300 });
  });

  it("creates staggered defaults for concurrent windows", () => {
    const first = defaultFloatingWindowGeometry({ width: 1000, height: 800 }, 0, "confirm");
    const second = defaultFloatingWindowGeometry({ width: 1000, height: 800 }, 1, "confirm");
    expect(second.x).toBe(first.x + 24);
    expect(second.y).toBe(first.y + 24);
  });
});
