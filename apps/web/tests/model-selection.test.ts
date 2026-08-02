import { describe, expect, it } from "vitest";
import { includesModel, resolveSelectableDefault, selectableModels } from "@/lib/model-selection";
import type { ModelListEntry } from "@/lib/web-api-client";

const models: ModelListEntry[] = [
  { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat", available: true },
  { provider: "openai", id: "gpt-5", name: "GPT-5", available: false },
  { provider: "legacy", id: "unknown", name: "Unknown" },
  { provider: "local", id: "local-model", name: "Local", available: true },
];

describe("conversation model selection", () => {
  it("keeps only models explicitly confirmed available by the Runtime", () => {
    expect(selectableModels(models).map((model) => `${model.provider}/${model.id}`)).toEqual([
      "deepseek/deepseek-chat",
      "local/local-model",
    ]);
  });

  it("uses an available global default and otherwise falls back to the first available model", () => {
    const available = selectableModels(models);
    expect(resolveSelectableDefault(available, { provider: "local", modelId: "local-model" })).toEqual({
      provider: "local",
      modelId: "local-model",
    });
    expect(resolveSelectableDefault(available, { provider: "openai", modelId: "gpt-5" })).toEqual({
      provider: "deepseek",
      modelId: "deepseek-chat",
    });
  });

  it("returns no default and rejects stale selections when no selectable model exists", () => {
    expect(resolveSelectableDefault([], { provider: "openai", modelId: "gpt-5" })).toBeNull();
    expect(includesModel(selectableModels(models), { provider: "openai", modelId: "gpt-5" })).toBe(false);
    expect(includesModel(selectableModels(models), { provider: "deepseek", modelId: "deepseek-chat" })).toBe(true);
  });
});
