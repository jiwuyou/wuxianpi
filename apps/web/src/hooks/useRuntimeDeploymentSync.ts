import { useEffect, useRef } from "react";
import {
  preserveRuntimeReloadDraft,
  reloadUrlForDeployment,
  RUNTIME_DEPLOYMENT_STORAGE_KEY,
  shouldReloadForDeployment,
} from "@/lib/runtime-deployment";

const STATUS_PATH = "/api/web/v1/status";
const CHECK_INTERVAL_MS = 30_000;

function readDeploymentId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).deploymentId;
  return typeof id === "string" && id.trim() ? id : null;
}

function storedDeploymentId(): string | null {
  try {
    return sessionStorage.getItem(RUNTIME_DEPLOYMENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberDeploymentId(deploymentId: string): void {
  try {
    sessionStorage.setItem(RUNTIME_DEPLOYMENT_STORAGE_KEY, deploymentId);
  } catch {
    // Embedded WebViews may not expose session storage.
  }
}

/** Keeps a long-lived browser or WebView page aligned with the deployed Runtime. */
export function useRuntimeDeploymentSync(): void {
  const reloadingRef = useRef(false);

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | undefined;

    const check = async () => {
      if (stopped || reloadingRef.current) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(STATUS_PATH, {
          cache: "no-store",
          headers: { "cache-control": "no-cache" },
          signal: controller.signal,
        });
        if (!response.ok || stopped) return;
        const deploymentId = readDeploymentId(await response.json());
        if (!deploymentId || stopped) return;
        const previous = storedDeploymentId();
        if (!shouldReloadForDeployment(previous, deploymentId)) {
          rememberDeploymentId(deploymentId);
          return;
        }

        reloadingRef.current = true;
        preserveRuntimeReloadDraft(document.querySelector<HTMLTextAreaElement>("textarea[data-wuxianpi-composer]")?.value ?? "");
        rememberDeploymentId(deploymentId);
        window.location.replace(reloadUrlForDeployment(window.location.href, deploymentId));
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          // A temporary Runtime outage should not disrupt an active chat page.
        }
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    void check();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, CHECK_INTERVAL_MS);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
