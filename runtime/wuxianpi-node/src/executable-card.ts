import { createHash, randomUUID } from "node:crypto";
import type { SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { RequestError } from "./protocol.js";

export const EXECUTABLE_CARD_TOOL = "present_executable_card";
export const EXECUTABLE_CARD_DETAILS_KEY = "wuxianpiExecutableCard";
export const CARD_SUBMISSION_ENTRY = "wuxianpi.executable-card-submission";
export const CARD_RESULT_ENTRY = "wuxianpi.executable-card-result";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type TemplateValue = JsonValue | { $field: string } | { $step: string } | { $env: string } | { $literal: JsonValue };

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

export type CardWorkflow =
  | { type: "process"; command: TemplateValue; args?: TemplateValue[]; cwd?: TemplateValue; env?: Record<string, TemplateValue>; timeoutMs?: number }
  | { type: "shell"; script: TemplateValue; shell?: string; cwd?: TemplateValue; env?: Record<string, TemplateValue>; timeoutMs?: number }
  | { type: "script"; runtime: "node" | "python" | "bash"; source: TemplateValue; args?: TemplateValue[]; cwd?: TemplateValue; env?: Record<string, TemplateValue>; timeoutMs?: number }
  | { type: "http"; method: string; url: TemplateValue; headers?: Record<string, TemplateValue>; body?: TemplateValue; timeoutMs?: number }
  | { type: "sequence"; steps: CardWorkflow[]; stopOnError?: boolean };

export interface ExecutableCardSpec {
  schemaVersion: 1;
  cardId: string;
  title: string;
  description?: string;
  fields: CardField[];
  submitLabel: string;
  workflow: CardWorkflow;
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

const fieldSchema = {
  type: "object",
  required: ["id", "type", "label"],
  properties: {
    id: { type: "string", description: "Stable field id used by workflow $field references" },
    type: { enum: ["text", "password", "textarea", "number", "select", "multi-select", "checkbox", "switch", "tags", "date", "datetime", "hidden"] },
    label: { type: "string" }, required: { type: "boolean" }, defaultValue: {}, placeholder: { type: "string" },
    options: { type: "array", items: { type: "object", required: ["label", "value"], properties: { label: { type: "string" }, value: {} } } },
    min: { type: "number" }, max: { type: "number" }, rows: { type: "number" },
  },
};

const workflowSchema = {
  oneOf: [
    { type: "object", required: ["type", "command"], properties: { type: { const: "process" }, command: {}, args: { type: "array", items: {} }, cwd: {}, env: { type: "object" }, timeoutMs: { type: "number" } } },
    { type: "object", required: ["type", "script"], properties: { type: { const: "shell" }, script: {}, shell: { type: "string" }, cwd: {}, env: { type: "object" }, timeoutMs: { type: "number" } } },
    { type: "object", required: ["type", "runtime", "source"], properties: { type: { const: "script" }, runtime: { enum: ["node", "python", "bash"] }, source: {}, args: { type: "array", items: {} }, cwd: {}, env: { type: "object" }, timeoutMs: { type: "number" } } },
    { type: "object", required: ["type", "method", "url"], properties: { type: { const: "http" }, method: { type: "string" }, url: {}, headers: { type: "object" }, body: {}, timeoutMs: { type: "number" } } },
    { type: "object", required: ["type", "steps"], properties: { type: { const: "sequence" }, steps: { type: "array", items: {} }, stopOnError: { type: "boolean" } } },
  ],
};

const cardToolParameters = {
  type: "object",
  required: ["title", "fields", "workflow"],
  properties: {
    title: { type: "string" }, description: { type: "string" },
    fields: { type: "array", items: fieldSchema }, workflow: workflowSchema,
    submitLabel: { type: "string" }, cwd: { type: "string" },
  },
};

export function createExecutableCardTool(): ToolDefinition {
  return defineTool({
    name: EXECUTABLE_CARD_TOOL,
    label: "Present executable card",
    description: "Present a native form whose workflow runs only after the user fills it and clicks submit. The workflow may run processes, shell commands, scripts, HTTP requests, or sequences with the same host authority as WuxianPi Runtime.",
    promptSnippet: "Present an executable form card and wait for the user to submit it",
    promptGuidelines: [
      "Use present_executable_card when the user should fill, review, or change values before execution.",
      "Prefer structured process arguments and $field references; use shell or script when arbitrary logic is required.",
      "Do not execute the workflow separately after presenting the card. The card runs it when the user submits.",
    ],
    parameters: cardToolParameters as never,
    async execute(_toolCallId, params) {
      const spec = createCardSpec(params as unknown as Record<string, unknown>);
      return {
        content: [{ type: "text", text: `Interactive card ready: ${spec.title}. Waiting for the user to submit it.` }],
        details: { [EXECUTABLE_CARD_DETAILS_KEY]: spec },
        terminate: true,
      };
    },
  });
}

export function createCardSpec(input: Record<string, unknown>): ExecutableCardSpec {
  const title = requireNonEmptyString(input.title, "title");
  if (!Array.isArray(input.fields)) throw new RequestError("invalid_card", "fields must be an array");
  const fields = input.fields.map((value, index) => parseField(value, index));
  const ids = new Set<string>();
  for (const field of fields) {
    if (ids.has(field.id)) throw new RequestError("invalid_card", `Duplicate field id: ${field.id}`);
    ids.add(field.id);
  }
  const workflow = parseWorkflow(input.workflow, 0);
  return {
    schemaVersion: 1,
    cardId: randomUUID(),
    title,
    ...(typeof input.description === "string" && input.description.trim() ? { description: input.description.trim() } : {}),
    fields,
    submitLabel: typeof input.submitLabel === "string" && input.submitLabel.trim() ? input.submitLabel.trim() : "Submit",
    workflow,
    workflowDigest: digestWorkflow(workflow),
    ...(typeof input.cwd === "string" && input.cwd.trim() ? { cwd: input.cwd } : {}),
    createdAt: new Date().toISOString(),
  };
}

export function digestWorkflow(workflow: CardWorkflow): string {
  return `sha256-${createHash("sha256").update(canonicalJson(workflow)).digest("hex")}`;
}

export function cardsFromEntries(entries: SessionEntry[]): ExecutableCardState[] {
  const cards = new Map<string, ExecutableCardState>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const candidate = asRecord(entry.message.details)[EXECUTABLE_CARD_DETAILS_KEY];
      if (candidate) {
        try {
          const spec = parseStoredSpec(candidate);
          cards.set(spec.cardId, { spec, state: "draft" });
        } catch {
          // Ignore malformed historical details instead of breaking the session snapshot.
        }
      }
      continue;
    }
    if (entry.type !== "custom") continue;
    const data = asRecord(entry.data);
    const cardId = typeof data.cardId === "string" ? data.cardId : "";
    const current = cards.get(cardId);
    if (!current) continue;
    if (entry.customType === CARD_SUBMISSION_ENTRY) {
      cards.set(cardId, {
        ...current,
        state: "running",
        requestId: typeof data.requestId === "string" ? data.requestId : undefined,
        values: asJsonRecord(data.values),
        startedAt: typeof data.startedAt === "string" ? data.startedAt : undefined,
        result: undefined,
        error: undefined,
      });
    } else if (entry.customType === CARD_RESULT_ENTRY) {
      const state = data.state === "success" || data.state === "error" || data.state === "cancelled" || data.state === "interrupted"
        ? data.state : "error";
      cards.set(cardId, {
        ...current,
        state,
        requestId: typeof data.requestId === "string" ? data.requestId : current.requestId,
        result: data.result,
        error: isRecord(data.error) && typeof data.error.message === "string"
          ? { code: typeof data.error.code === "string" ? data.error.code : "execution_failed", message: data.error.message }
          : undefined,
        completedAt: typeof data.completedAt === "string" ? data.completedAt : undefined,
      });
    }
  }
  return [...cards.values()];
}

export function validateCardValues(spec: ExecutableCardSpec, input: unknown): Record<string, JsonValue> {
  if (!isRecord(input)) throw new RequestError("invalid_card_values", "values must be an object");
  const values: Record<string, JsonValue> = {};
  for (const field of spec.fields) {
    const value = input[field.id] ?? field.defaultValue;
    if (field.required && (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0))) {
      throw new RequestError("invalid_card_values", `${field.label} is required`);
    }
    if (value === undefined) continue;
    if (!isJsonValue(value)) throw new RequestError("invalid_card_values", `${field.label} must be JSON-compatible`);
    if (field.type === "number" && typeof value !== "number") throw new RequestError("invalid_card_values", `${field.label} must be a number`);
    if ((field.type === "checkbox" || field.type === "switch") && typeof value !== "boolean") throw new RequestError("invalid_card_values", `${field.label} must be a boolean`);
    if ((field.type === "tags" || field.type === "multi-select") && !Array.isArray(value)) throw new RequestError("invalid_card_values", `${field.label} must be an array`);
    values[field.id] = value;
  }
  return values;
}

function parseStoredSpec(value: unknown): ExecutableCardSpec {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.cardId !== "string" || typeof value.createdAt !== "string") {
    throw new RequestError("invalid_card", "Stored card is invalid");
  }
  const parsed = createCardSpec(value);
  return {
    ...parsed,
    cardId: value.cardId,
    createdAt: value.createdAt,
    workflowDigest: typeof value.workflowDigest === "string" ? value.workflowDigest : digestWorkflow(parsed.workflow),
  };
}

function parseField(value: unknown, index: number): CardField {
  if (!isRecord(value)) throw new RequestError("invalid_card", `fields[${index}] must be an object`);
  const type = requireNonEmptyString(value.type, `fields[${index}].type`) as CardField["type"];
  const allowed = new Set<CardField["type"]>(["text", "password", "textarea", "number", "select", "multi-select", "checkbox", "switch", "tags", "date", "datetime", "hidden"]);
  if (!allowed.has(type)) throw new RequestError("invalid_card", `Unsupported field type: ${type}`);
  const options = Array.isArray(value.options) ? value.options.map((option, optionIndex) => {
    if (!isRecord(option) || typeof option.label !== "string" || !isJsonValue(option.value)) {
      throw new RequestError("invalid_card", `fields[${index}].options[${optionIndex}] is invalid`);
    }
    return { label: option.label, value: option.value };
  }) : undefined;
  return {
    id: requireNonEmptyString(value.id, `fields[${index}].id`),
    type,
    label: requireNonEmptyString(value.label, `fields[${index}].label`),
    ...(value.required === true ? { required: true } : {}),
    ...(isJsonValue(value.defaultValue) ? { defaultValue: value.defaultValue } : {}),
    ...(typeof value.placeholder === "string" ? { placeholder: value.placeholder } : {}),
    ...(options ? { options } : {}),
    ...(typeof value.min === "number" ? { min: value.min } : {}),
    ...(typeof value.max === "number" ? { max: value.max } : {}),
    ...(typeof value.rows === "number" ? { rows: value.rows } : {}),
  };
}

function parseWorkflow(value: unknown, depth: number): CardWorkflow {
  if (depth > 12 || !isRecord(value)) throw new RequestError("invalid_card", "workflow is invalid or too deeply nested");
  const type = requireNonEmptyString(value.type, "workflow.type");
  const common = {
    ...(value.cwd !== undefined ? { cwd: value.cwd as TemplateValue } : {}),
    ...(isRecord(value.env) ? { env: value.env as Record<string, TemplateValue> } : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
  };
  if (type === "process") return { type, command: value.command as TemplateValue, ...(Array.isArray(value.args) ? { args: value.args as TemplateValue[] } : {}), ...common };
  if (type === "shell") return { type, script: value.script as TemplateValue, ...(typeof value.shell === "string" ? { shell: value.shell } : {}), ...common };
  if (type === "script") {
    if (value.runtime !== "node" && value.runtime !== "python" && value.runtime !== "bash") throw new RequestError("invalid_card", "script.runtime must be node, python, or bash");
    return { type, runtime: value.runtime, source: value.source as TemplateValue, ...(Array.isArray(value.args) ? { args: value.args as TemplateValue[] } : {}), ...common };
  }
  if (type === "http") return {
    type,
    method: requireNonEmptyString(value.method, "workflow.method"),
    url: value.url as TemplateValue,
    ...(isRecord(value.headers) ? { headers: value.headers as Record<string, TemplateValue> } : {}),
    ...(value.body !== undefined ? { body: value.body as TemplateValue } : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
  };
  if (type === "sequence") {
    if (!Array.isArray(value.steps)) throw new RequestError("invalid_card", "sequence.steps must be an array");
    return { type, steps: value.steps.map((step) => parseWorkflow(step, depth + 1)), ...(value.stopOnError === false ? { stopOnError: false } : {}) };
  }
  throw new RequestError("invalid_card", `Unsupported workflow type: ${type}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RequestError("invalid_card", `${name} must be a non-empty string`);
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function asJsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, JsonValue] => isJsonValue(entry[1])));
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isJsonValue(value: unknown): value is JsonValue {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isJsonValue)) || (isRecord(value) && Object.values(value).every(isJsonValue));
}
