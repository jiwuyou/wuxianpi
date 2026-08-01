import { RequestError } from "./protocol.js";

export const BROWSER_HOST_PROTOCOL = "wuxianpi-browser-host-v1" as const;
export const BROWSER_HOST_PROTOCOL_VERSION = 1 as const;
export const BROWSER_HOST_WEBSOCKET_PATH = "/v1/browser-host" as const;

export type BrowserJsonObject = Record<string, unknown>;

export interface BrowserTabSnapshot extends BrowserJsonObject {
  tabId: string;
  active?: boolean;
  url?: string;
  title?: string;
  context?: BrowserJsonObject | null;
}

export interface BrowserHostRegistration {
  type: "browser.register";
  protocol: typeof BROWSER_HOST_PROTOCOL;
  protocolVersion: typeof BROWSER_HOST_PROTOCOL_VERSION;
  hostId: string;
  priority?: number;
  implementationVersion?: string;
  capabilities: BrowserJsonObject;
  tabs: BrowserTabSnapshot[];
  context?: BrowserJsonObject | null;
}

export interface BrowserHostResultMessage {
  type: "browser.result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface BrowserHostEventMessage {
  type: "browser.event";
  event: string;
  at?: string | number;
  tabId?: string;
  data?: BrowserJsonObject;
  tabs?: BrowserTabSnapshot[];
  context?: BrowserJsonObject | null;
}

export type BrowserHostClientMessage = BrowserHostRegistration | BrowserHostResultMessage | BrowserHostEventMessage;

export interface BrowserTarget extends BrowserJsonObject {
  hostId?: string;
  tabId?: string;
}

export interface BrowserInvocationInput {
  method: string;
  hostId?: string;
  target?: BrowserTarget;
  params?: BrowserJsonObject;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BrowserInvokeMessage {
  type: "browser.invoke";
  protocol: typeof BROWSER_HOST_PROTOCOL;
  protocolVersion: typeof BROWSER_HOST_PROTOCOL_VERSION;
  id: string;
  method: string;
  target: BrowserTarget;
  params: BrowserJsonObject;
}

export function parseBrowserHostClientMessage(raw: string): BrowserHostClientMessage {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new RequestError("invalid_json", "Browser Host frame must be valid JSON"); }
  const message = requireRecord(value, "Browser Host frame must be a JSON object");
  const type = requireNonEmptyString(message.type, "type");
  switch (type) {
    case "browser.register": return parseRegistration(message);
    case "browser.result": return parseResult(message);
    case "browser.event": return parseEvent(message);
    default: throw new RequestError("unsupported_browser_message", `Unsupported Browser Host message: ${type}`);
  }
}

export function normalizeBrowserInvocation(input: BrowserInvocationInput): Omit<BrowserInvocationInput, "signal"> {
  const method = requireNonEmptyString(input.method, "method");
  if (!/^[a-z][a-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(method)) {
    throw new RequestError("invalid_browser_method", "method must use a transport-neutral namespace such as tabs.list or page.getText");
  }
  const hostId = optionalNonEmptyString(input.hostId, "hostId");
  const target = input.target === undefined ? {} : requireRecord(input.target, "target must be an object") as BrowserTarget;
  if (target.hostId !== undefined) optionalNonEmptyString(target.hostId, "target.hostId");
  if (target.tabId !== undefined) optionalNonEmptyString(target.tabId, "target.tabId");
  const params = input.params === undefined ? {} : requireRecord(input.params, "params must be an object");
  let timeoutMs = input.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)) {
    throw new RequestError("invalid_payload", "timeoutMs must be an integer between 1 and 120000");
  }
  return { method, ...(hostId ? { hostId } : {}), target, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function parseRegistration(message: BrowserJsonObject): BrowserHostRegistration {
  if (message.protocol !== BROWSER_HOST_PROTOCOL || message.protocolVersion !== BROWSER_HOST_PROTOCOL_VERSION) {
    throw new RequestError("browser_protocol_mismatch", `Expected ${BROWSER_HOST_PROTOCOL} version ${BROWSER_HOST_PROTOCOL_VERSION}`);
  }
  const priority = message.priority;
  if (priority !== undefined && (!Number.isSafeInteger(priority) || (priority as number) < -10_000 || (priority as number) > 10_000)) {
    throw new RequestError("invalid_browser_registration", "priority must be a safe integer between -10000 and 10000");
  }
  if (!Array.isArray(message.tabs)) throw new RequestError("invalid_browser_registration", "tabs must be an array");
  return {
    type: "browser.register",
    protocol: BROWSER_HOST_PROTOCOL,
    protocolVersion: BROWSER_HOST_PROTOCOL_VERSION,
    hostId: requireNonEmptyString(message.hostId, "hostId"),
    ...(priority === undefined ? {} : { priority: priority as number }),
    ...(message.implementationVersion === undefined ? {} : {
      implementationVersion: requireNonEmptyString(message.implementationVersion, "implementationVersion"),
    }),
    capabilities: requireRecord(message.capabilities, "capabilities must be an object"),
    tabs: message.tabs.map((tab, index) => parseTab(tab, index)),
    ...(message.context === undefined ? {} : { context: parseNullableRecord(message.context, "context") }),
  };
}

function parseResult(message: BrowserJsonObject): BrowserHostResultMessage {
  if (typeof message.ok !== "boolean") throw new RequestError("invalid_browser_result", "ok must be a boolean");
  if (!message.ok) {
    const error = requireRecord(message.error, "error must be an object when ok is false");
    return {
      type: "browser.result",
      id: requireNonEmptyString(message.id, "id"),
      ok: false,
      error: {
        code: requireNonEmptyString(error.code, "error.code"),
        message: requireNonEmptyString(error.message, "error.message"),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return { type: "browser.result", id: requireNonEmptyString(message.id, "id"), ok: true, result: message.result };
}

function parseEvent(message: BrowserJsonObject): BrowserHostEventMessage {
  if (message.tabs !== undefined && !Array.isArray(message.tabs)) {
    throw new RequestError("invalid_browser_event", "tabs must be an array");
  }
  if (message.at !== undefined && typeof message.at !== "string" && typeof message.at !== "number") {
    throw new RequestError("invalid_browser_event", "at must be a string or number");
  }
  return {
    type: "browser.event",
    event: requireNonEmptyString(message.event, "event"),
    ...(message.at === undefined ? {} : { at: message.at as string | number }),
    ...(message.tabId === undefined ? {} : { tabId: requireNonEmptyString(message.tabId, "tabId") }),
    ...(message.data === undefined ? {} : { data: requireRecord(message.data, "data must be an object") }),
    ...(message.tabs === undefined ? {} : { tabs: message.tabs.map((tab, index) => parseTab(tab, index)) }),
    ...(message.context === undefined ? {} : { context: parseNullableRecord(message.context, "context") }),
  };
}

function parseTab(value: unknown, index: number): BrowserTabSnapshot {
  const tab = requireRecord(value, `tabs[${index}] must be an object`);
  if (tab.active !== undefined && typeof tab.active !== "boolean") {
    throw new RequestError("invalid_browser_registration", `tabs[${index}].active must be a boolean`);
  }
  for (const field of ["url", "title"] as const) {
    if (tab[field] !== undefined && typeof tab[field] !== "string") {
      throw new RequestError("invalid_browser_registration", `tabs[${index}].${field} must be a string`);
    }
  }
  return {
    ...tab,
    tabId: requireNonEmptyString(tab.tabId, `tabs[${index}].tabId`),
    ...(tab.context === undefined ? {} : { context: parseNullableRecord(tab.context, `tabs[${index}].context`) }),
  } as BrowserTabSnapshot;
}

function parseNullableRecord(value: unknown, name: string): BrowserJsonObject | null {
  return value === null ? null : requireRecord(value, `${name} must be an object or null`);
}

function requireRecord(value: unknown, message: string): BrowserJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError("invalid_payload", message);
  return value as BrowserJsonObject;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RequestError("invalid_payload", `${name} must be a non-empty string`);
  return value.trim();
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : requireNonEmptyString(value, name);
}
