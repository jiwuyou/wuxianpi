import { describe, expect, it } from "vitest";
import { executableCardSpec, normalizeCardState } from "../src/lib/executable-card";
import { normalizeToolCalls } from "../src/lib/normalize";

const spec = {
  schemaVersion: 1 as const,
  cardId: "card-1",
  title: "Memo",
  fields: [{ id: "content", type: "textarea" as const, label: "Content" }],
  submitLabel: "Save",
  workflow: { type: "shell", script: "true" },
  workflowDigest: "sha256-test",
  createdAt: "2026-08-02T00:00:00.000Z",
};

describe("executable cards", () => {
  it("extracts a card spec from tool result details", () => {
    expect(executableCardSpec({ wuxianpiExecutableCard: spec })).toEqual(spec);
    expect(executableCardSpec({})).toBeNull();
  });

  it("normalizes Pi tool call fields after a session snapshot reload", () => {
    const message = normalizeToolCalls({
      role: "assistant",
      model: "test",
      provider: "test",
      content: [{ type: "toolCall", id: "call-1", name: "present_executable_card", arguments: { title: "Memo" } } as never],
    });
    expect(message.role).toBe("assistant");
    if (message.role !== "assistant") throw new Error("Expected assistant message");
    expect(message.content[0]).toMatchObject({
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "present_executable_card",
      input: { title: "Memo" },
    });
  });

  it("normalizes persisted card state", () => {
    expect(normalizeCardState({ spec, state: "success", result: { id: "memo-1" } })).toMatchObject({
      state: "success",
      result: { id: "memo-1" },
    });
    expect(normalizeCardState({ spec, state: "unknown" })).toBeNull();
  });
});
