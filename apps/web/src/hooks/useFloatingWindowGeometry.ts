import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampFloatingWindowGeometry,
  defaultFloatingWindowGeometry,
  geometryFromStorage,
  geometryStorageValue,
  rescaleFloatingWindowGeometry,
  type FloatingWindowGeometry,
  type FloatingWindowMethod,
  type FloatingWindowViewport,
} from "@/lib/floating-window";

export function useFloatingWindowGeometry(
  storageKey: string,
  viewport: FloatingWindowViewport,
  offset: number,
  method: FloatingWindowMethod,
) {
  const previousViewportRef = useRef(viewport);
  const [geometry, setGeometry] = useState<FloatingWindowGeometry>(() => {
    const saved = typeof window === "undefined" ? null : geometryFromStorage(window.localStorage.getItem(storageKey), viewport);
    return saved ?? defaultFloatingWindowGeometry(viewport, offset, method);
  });

  useEffect(() => {
    const previous = previousViewportRef.current;
    previousViewportRef.current = viewport;
    if (previous.width === viewport.width && previous.height === viewport.height) return;
    setGeometry((current) => rescaleFloatingWindowGeometry(current, previous, viewport));
  }, [viewport]);

  const update = useCallback((next: FloatingWindowGeometry, measuredHeight?: number) => {
    setGeometry(clampFloatingWindowGeometry(next, viewport, measuredHeight));
  }, [viewport]);

  const commit = useCallback((next: FloatingWindowGeometry, measuredHeight?: number) => {
    const clamped = clampFloatingWindowGeometry(next, viewport, measuredHeight);
    setGeometry(clamped);
    try { window.localStorage.setItem(storageKey, geometryStorageValue(clamped, viewport)); } catch { /* Layout persistence is optional. */ }
  }, [storageKey, viewport]);

  const reset = useCallback(() => {
    const next = defaultFloatingWindowGeometry(viewport, offset, method);
    setGeometry(next);
    try { window.localStorage.removeItem(storageKey); } catch { /* Layout persistence is optional. */ }
  }, [method, offset, storageKey, viewport]);

  return { geometry, update, commit, reset };
}
