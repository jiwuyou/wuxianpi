import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { FunctionalAssistantSharingMode } from "./package-types.js";
import {
  FunctionalAssistantStorage,
  type FunctionalAssistantStateScope,
} from "./functional-assistant-storage.js";
import { RequestError } from "./protocol.js";

export const FUNCTIONAL_ASSISTANT_STATE_TOOL = "functional_assistant_state";
export const FUNCTIONAL_ASSISTANT_STATE_DETAILS_KEY = "wuxianpiFunctionalAssistantState";

export interface BoundFunctionalAssistantState {
  functionId: string;
  sharingMode: FunctionalAssistantSharingMode;
}

export function createFunctionalAssistantStateTool(options: {
  assistantId: string;
  bindings: BoundFunctionalAssistantState[];
  storage: FunctionalAssistantStorage;
}): ToolDefinition {
  const bindings = new Map(options.bindings.map((binding) => [binding.functionId, binding]));
  const boundIds = [...bindings.keys()].sort();
  return defineTool({
    name: FUNCTIONAL_ASSISTANT_STATE_TOOL,
    label: "Functional assistant state",
    description: `Read and write bounded persistent state for functional assistants bound to this main assistant. Bound functionIds: ${boundIds.join(", ") || "none"}.`,
    promptSnippet: "Read or update persistent state owned by a bound functional assistant",
    promptGuidelines: [
      "Use functional_assistant_state only for the domain state of a currently bound functional assistant.",
      "Use profile state for assistant-specific progress and shared state only for information intentionally shared across main assistants.",
    ],
    parameters: {
      type: "object",
      required: ["operation", "functionId"],
      additionalProperties: false,
      properties: {
        operation: { enum: ["list", "read", "write"] },
        functionId: { type: "string" },
        path: { type: "string" },
        scope: { enum: ["auto", "shared", "profile"] },
        content: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        maxBytes: { type: "integer", minimum: 1 },
      },
    } as never,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as unknown as Record<string, unknown>;
      const functionId = requiredString(params.functionId, "functionId");
      const binding = bindings.get(functionId);
      if (!binding) throw new RequestError("functional_assistant_unbound", `Functional assistant is not bound to ${options.assistantId}: ${functionId}`);
      const operation = params.operation;
      const scope = optionalScope(params.scope);
      const access = { functionId, assistantId: options.assistantId, sharingMode: binding.sharingMode };
      let result: Record<string, unknown>;
      if (operation === "list") {
        result = await options.storage.list({ ...access, path: optionalString(params.path), scope });
      } else if (operation === "read") {
        result = await options.storage.read({
          ...access,
          path: requiredString(params.path, "path"),
          scope,
          offset: optionalInteger(params.offset, "offset"),
          maxBytes: optionalInteger(params.maxBytes, "maxBytes"),
        });
      } else if (operation === "write") {
        result = await options.storage.write({
          ...access,
          path: requiredString(params.path, "path"),
          content: requiredString(params.content, "content", true),
          scope,
        });
      } else {
        throw new RequestError("invalid_functional_assistant_state_operation", `Unsupported functional assistant state operation: ${String(operation)}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { [FUNCTIONAL_ASSISTANT_STATE_DETAILS_KEY]: result },
      };
    },
  });
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new RequestError("invalid_functional_assistant_state", `${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RequestError("invalid_functional_assistant_state", "path must be a string");
  return value;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new RequestError("invalid_functional_assistant_state", `${label} must be an integer`);
  return value as number;
}

function optionalScope(value: unknown): FunctionalAssistantStateScope | undefined {
  if (value === undefined) return undefined;
  if (value !== "auto" && value !== "shared" && value !== "profile") {
    throw new RequestError("invalid_functional_assistant_state", "scope must be auto, shared, or profile");
  }
  return value;
}
