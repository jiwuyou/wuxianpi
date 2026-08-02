import type { ModelListEntry } from "@/lib/web-api-client";

export interface SelectedModelRef {
  provider: string;
  modelId: string;
}

export function isSameModel(model: Pick<ModelListEntry, "provider" | "id">, selected: SelectedModelRef | null | undefined): boolean {
  return !!selected && model.provider === selected.provider && model.id === selected.modelId;
}

export function selectableModels(models: readonly ModelListEntry[]): ModelListEntry[] {
  return models.filter((model) => model.available === true);
}

export function includesModel(models: readonly ModelListEntry[], selected: SelectedModelRef | null | undefined): boolean {
  return !!selected && models.some((model) => isSameModel(model, selected));
}

export function resolveSelectableDefault(
  models: readonly ModelListEntry[],
  defaultModel: SelectedModelRef | null | undefined,
): SelectedModelRef | null {
  const selected = models.find((model) => isSameModel(model, defaultModel)) ?? models[0];
  return selected ? { provider: selected.provider, modelId: selected.id } : null;
}
