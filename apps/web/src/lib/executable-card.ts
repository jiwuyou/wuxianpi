export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CardField {
  id: string;
  type: "text" | "password" | "textarea" | "number" | "select" | "multi-select" |
    "checkbox" | "switch" | "tags" | "date" | "datetime" | "hidden";
  label: string;
  required?: boolean;
  defaultValue?: JsonValue;
  placeholder?: string;
  options?: Array<{ label: string; value: JsonValue }>;
  min?: number;
  max?: number;
  rows?: number;
}

export interface ExecutableCardSpec {
  schemaVersion: 1;
  cardId: string;
  title: string;
  description?: string;
  fields: CardField[];
  submitLabel: string;
  workflow: Record<string, unknown>;
  workflowDigest: string;
  cwd?: string;
  createdAt: string;
}

export interface ExecutableCardState {
  spec: ExecutableCardSpec;
  state: "draft" | "running" | "success" | "error" | "cancelled" | "interrupted";
  requestId?: string;
  values?: Record<string, JsonValue>;
  result?: unknown;
  error?: { code: string; message: string };
  startedAt?: string;
  completedAt?: string;
}

export const EXECUTABLE_CARD_DETAILS_KEY = "wuxianpiExecutableCard";

export function executableCardSpec(details: unknown): ExecutableCardSpec | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const candidate = (details as Record<string, unknown>)[EXECUTABLE_CARD_DETAILS_KEY];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const spec = candidate as Partial<ExecutableCardSpec>;
  if (spec.schemaVersion !== 1 || typeof spec.cardId !== "string" || typeof spec.title !== "string" ||
      typeof spec.workflowDigest !== "string" || !Array.isArray(spec.fields)) return null;
  return spec as ExecutableCardSpec;
}

export function normalizeCardState(value: unknown): ExecutableCardState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<ExecutableCardState>;
  if (!row.spec || typeof row.spec !== "object" || typeof row.spec.cardId !== "string") return null;
  if (!row.state || !["draft", "running", "success", "error", "cancelled", "interrupted"].includes(row.state)) return null;
  return row as ExecutableCardState;
}
