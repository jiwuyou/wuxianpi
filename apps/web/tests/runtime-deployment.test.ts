import { describe, expect, it } from "vitest";
import {
  reloadUrlForDeployment,
  runtimeReloadRoute,
  RUNTIME_DEPLOYMENT_QUERY_PARAM,
  shouldReloadForDeployment,
} from "@/lib/runtime-deployment";

describe("runtime deployment synchronization", () => {
  it("records the first deployment and reloads only after the Runtime changes", () => {
    expect(shouldReloadForDeployment(null, "sha256-new")).toBe(false);
    expect(shouldReloadForDeployment("sha256-current", "sha256-current")).toBe(false);
    expect(shouldReloadForDeployment("sha256-current", "sha256-new")).toBe(true);
  });

  it("keeps the current route while forcing a versioned document request", () => {
    const result = reloadUrlForDeployment("http://127.0.0.1:30143/?session=abc", "sha256-new");
    const url = new URL(result);
    expect(url.searchParams.get("session")).toBe("abc");
    expect(url.searchParams.get(RUNTIME_DEPLOYMENT_QUERY_PARAM)).toBe("sha256-new");
    expect(runtimeReloadRoute(result)).toBe("/?session=abc");
  });
});
