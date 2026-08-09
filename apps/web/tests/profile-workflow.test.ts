import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { SessionInfo } from "../src/lib/types";
import type { AssistantSummary } from "../src/lib/wuxianpi/contracts";
import { groupSessionsByAssistant } from "../src/components/AppShell";
import { selectableWorkspaces } from "../src/components/ChatWindow";
import { buildNewSessionRequest } from "../src/hooks/useAgentSession";
import {
  functionalAssistantCandidates,
  updateFunctionalAssistantBinding,
} from "../src/components/wuxianpi/FunctionalAssistantBindings";
import { packageCapabilityBindings } from "../src/components/wuxianpi/PackageAssistantCapabilities";

function assistant(id: string): AssistantSummary {
  return {
    id,
    path: `/assistants/${id}`,
    manifest: { schemaVersion: 1, name: id, model: "inherit", tools: "inherit" },
    sessionCount: 0,
    diagnostics: [],
  };
}

function session(input: Partial<SessionInfo> & Pick<SessionInfo, "id">): SessionInfo {
  const { id, ...overrides } = input;
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: "/shared/project",
    assistantId: "assistant-a",
    workspaceId: null,
    ownershipState: "bound",
    created: "2026-08-04T00:00:00.000Z",
    modified: "2026-08-04T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...overrides,
    bindingRevision: overrides.bindingRevision ?? 1,
  };
}

describe("Profile and Workspace Web flow", () => {
  it("groups sessions by explicit assistantId even when cwd is identical", () => {
    const grouped = groupSessionsByAssistant(
      [assistant("assistant-a"), assistant("assistant-b")],
      [
        session({ id: "session-a", assistantId: "assistant-a" }),
        session({ id: "session-b", assistantId: "assistant-b" }),
      ],
    );

    expect(grouped.map.get("assistant-a")?.map((item) => item.id)).toEqual(["session-a"]);
    expect(grouped.map.get("assistant-b")?.map((item) => item.id)).toEqual(["session-b"]);
  });

  it("keeps unbound Pi sessions in a separate openable group", () => {
    const unbound = session({ id: "pi-session", assistantId: null, ownershipState: "unbound" });
    const grouped = groupSessionsByAssistant([assistant("assistant-a")], [unbound]);

    expect(grouped.unbound).toEqual([unbound]);
    expect(grouped.map.get("assistant-a")).toEqual([]);
  });

  it("creates daily chats without forcing cwd and Workspace chats with explicit scope", () => {
    expect(buildNewSessionRequest({ assistantId: "assistant-a" })).toEqual({ assistantId: "assistant-a" });
    expect(buildNewSessionRequest({
      assistantId: "assistant-a",
      workspaceId: "leetcode",
      cwd: "/home/leetcode",
      toolNames: ["read", "bash"],
    })).toEqual({
      assistantId: "assistant-a",
      workspaceId: "leetcode",
      cwd: "/home/leetcode",
      toolNames: ["read", "bash"],
    });
  });

  it("loads archived Workspaces for management but excludes them from the active chat selector", () => {
    const source = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
    const active = selectableWorkspaces([
      { id: "active", name: "活动项目", rootCwd: "/active", archived: false, createdAt: "", updatedAt: "", instructions: "", memory: "" },
      { id: "archived", name: "归档项目", rootCwd: "/archived", archived: true, createdAt: "", updatedAt: "", instructions: "", memory: "" },
    ]);

    expect(source).toContain("listWorkspaces({ includeArchived: true })");
    expect(active.map((workspace) => workspace.id)).toEqual(["active"]);
  });

  it("updates functional assistant state without dropping other contributions or experience spaces", () => {
    const initial = {
      assistantId: "assistant-a",
      enabledContributionIds: ["pkg/skill", "pkg/experience"],
      experienceSpaces: { "pkg/experience": "assistant-a.experience" },
      functionalAssistants: {},
    };
    const enabled = updateFunctionalAssistantBinding(initial, "pkg/assistant.english", true, "isolated");
    const disabled = updateFunctionalAssistantBinding(enabled, "pkg/assistant.english", false);

    expect(enabled.enabledContributionIds).toEqual(["pkg/skill", "pkg/experience", "pkg/assistant.english"]);
    expect(enabled.experienceSpaces).toEqual(initial.experienceSpaces);
    expect(enabled.functionalAssistants).toEqual({ "pkg/assistant.english": { sharingMode: "isolated" } });
    expect(disabled.enabledContributionIds).toEqual(initial.enabledContributionIds);
    expect(disabled.experienceSpaces).toEqual(initial.experienceSpaces);
  });

  it("discovers only installed functional assistant templates", () => {
    const result = functionalAssistantCandidates({
      packages: [{
        packageId: "pkg",
        contributions: [
          { id: "pkg/functional", enabled: true, contribution: { type: "wuxianpi.assistantTemplate", kind: "functional", name: "英语陪练" } },
          { id: "pkg/main", enabled: true, contribution: { type: "wuxianpi.assistantTemplate", kind: "main", name: "主助手" } },
        ],
      }],
    });

    expect(result.map((item) => item.id)).toEqual(["pkg/functional"]);
  });

  it("shows Package contributions already bound to an assistant", () => {
    const packages = packageCapabilityBindings({
      packages: [{
        packageId: "io.test.github",
        name: "GitHub Bug 报告助手",
        contributions: [
          { id: "io.test.github/extension", contribution: { name: "GitHub Issue 提交工具" } },
          { id: "io.test.github/skill", contribution: { name: "GitHub Bug 报告流程" } },
          { id: "io.test.github/unused", contribution: { name: "未绑定能力" } },
        ],
      }],
    }, {
      enabledContributionIds: ["io.test.github/extension", "io.test.github/skill"],
    });

    expect(packages).toEqual([{
      packageId: "io.test.github",
      packageName: "GitHub Bug 报告助手",
      contributionNames: ["GitHub Issue 提交工具", "GitHub Bug 报告流程"],
    }]);
  });
});
