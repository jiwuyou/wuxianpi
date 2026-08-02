import { describe, expect, it } from "vitest";
import { assistantAvatarBackground, assistantAvatarUrl } from "@/lib/assistant-avatar";
import type { AssistantSummary } from "@/lib/wuxianpi/contracts";

function assistant(avatar?: string): AssistantSummary {
  return {
    id: "writing-partner",
    path: "/tmp/assistants/writing-partner",
    manifest: { schemaVersion: 1, name: "Writer", avatar },
    sessionCount: 0,
    diagnostics: [],
  };
}

describe("assistant avatar URLs", () => {
  it("routes relative assistant assets through the scoped avatar endpoint", () => {
    expect(assistantAvatarUrl(assistant(".assets/avatar-abcd.webp"))).toBe(
      "/api/web/v1/assistants/writing-partner/avatar?v=.assets%2Favatar-abcd.webp",
    );
  });

  it("keeps HTTP URLs and rejects unsafe or executable schemes", () => {
    expect(assistantAvatarUrl(assistant("https://example.com/avatar.png"))).toBe("https://example.com/avatar.png");
    expect(assistantAvatarUrl(assistant("../secret.png"))).toBeNull();
    expect(assistantAvatarUrl(assistant("javascript:alert(1)"))).toBeNull();
    expect(assistantAvatarUrl(assistant("data:image/png;base64,abc"))).toBeNull();
  });

  it("quotes background image URLs for CSS style values", () => {
    expect(assistantAvatarBackground("https://example.com/a b.png")).toBe('url("https://example.com/a b.png")');
  });
});
