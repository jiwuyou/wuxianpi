export const RUNTIME_DEPLOYMENT_STORAGE_KEY = "wuxianpi:runtime-deployment-id";
export const RUNTIME_RELOAD_DRAFT_STORAGE_KEY = "wuxianpi:runtime-reload-draft";
export const RUNTIME_DEPLOYMENT_QUERY_PARAM = "__wuxianpi_runtime";

type StoredDraft = {
  route: string;
  value: string;
};

export function reloadUrlForDeployment(href: string, deploymentId: string): string {
  const url = new URL(href);
  url.searchParams.set(RUNTIME_DEPLOYMENT_QUERY_PARAM, deploymentId);
  return url.toString();
}

export function runtimeReloadRoute(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(RUNTIME_DEPLOYMENT_QUERY_PARAM);
  return `${url.pathname}${url.search}`;
}

export function shouldReloadForDeployment(previous: string | null, next: string): boolean {
  return !!previous && previous !== next;
}

export function preserveRuntimeReloadDraft(value: string): void {
  if (!value.trim()) return;
  try {
    const draft: StoredDraft = { route: runtimeReloadRoute(window.location.href), value };
    sessionStorage.setItem(RUNTIME_RELOAD_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
  }
}

export function consumeRuntimeReloadDraft(): string | null {
  try {
    const raw = sessionStorage.getItem(RUNTIME_RELOAD_DRAFT_STORAGE_KEY);
    sessionStorage.removeItem(RUNTIME_RELOAD_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof draft.value !== "string" || draft.route !== runtimeReloadRoute(window.location.href)) return null;
    return draft.value;
  } catch {
    return null;
  }
}
