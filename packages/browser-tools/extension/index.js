import { Type } from "@earendil-works/pi-ai";

const DEFAULT_RUNTIME_ORIGIN = "http://127.0.0.1:20765";

export function createBrowserTools(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? runtimeOriginFromEnvironment());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Browser tools require fetch support");

  const commonTargetFields = {
    hostId: Type.Optional(Type.String({ description: "Explicit Browser Host id. Omit to use the preferred connected host." })),
    tabId: Type.Optional(Type.String({ description: "Target browser tab id when the operation applies to one tab." })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000, description: "Browser Host response timeout in milliseconds." })),
  };

  return [
    {
      name: "browser_operation",
      label: "Browser operation",
      description: "Invoke a transport-neutral operation on the connected WuxianPi Browser Host.",
      promptSnippet: "Control the shared browser with stable methods such as tabs.list, page.getText, page.click, or page.screenshot.",
      parameters: Type.Object({
        method: Type.String({ description: "Browser Host method, for example tabs.list, page.navigate, page.getText, or page.click." }),
        params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Method-specific parameters." })),
        ...commonTargetFields,
      }),
      execute: async (_toolCallId, params, signal) => toolResult(await invokeBrowserHost(fetchImpl, baseUrl, {
        method: params.method,
        ...(params.hostId ? { hostId: params.hostId } : {}),
        ...(params.tabId ? { target: { tabId: params.tabId } } : {}),
        params: params.params ?? {},
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      }, signal)),
    },
    {
      name: "app_action",
      label: "App action",
      description: "Invoke a business-level action exposed by the app in a shared-browser tab.",
      promptSnippet: "Prefer a declared app action over DOM automation when the current app exposes one.",
      parameters: Type.Object({
        action: Type.String({ description: "Action name returned by app.listActions." }),
        appId: Type.Optional(Type.String({ description: "Expected app id. Omit to use the active tab context." })),
        args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Action arguments." })),
        ...commonTargetFields,
      }),
      execute: async (_toolCallId, params, signal) => toolResult(await invokeBrowserHost(fetchImpl, baseUrl, {
        method: "app.invoke",
        ...(params.hostId ? { hostId: params.hostId } : {}),
        ...(params.tabId ? { target: { tabId: params.tabId } } : {}),
        params: {
          action: params.action,
          ...(params.appId ? { appId: params.appId } : {}),
          args: params.args ?? {},
        },
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      }, signal)),
    },
  ];
}

export async function invokeBrowserHost(fetchImpl, baseUrl, body, signal) {
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/web/v1/browser/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || !payload?.ok) {
    const code = payload?.error?.code ?? `http_${response.status}`;
    const message = payload?.error?.message ?? `Browser Host request failed with HTTP ${response.status}`;
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload.data;
}

export function runtimeOriginFromEnvironment(env = process.env) {
  return env.WUXIANPI_BROWSER_RUNTIME_URL || env.WUXIANPI_RUNTIME_URL || DEFAULT_RUNTIME_ORIGIN;
}

export default function registerBrowserTools(pi) {
  for (const tool of createBrowserTools()) pi.registerTool(tool);
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_RUNTIME_ORIGIN).replace(/\/+$/, "");
}

function toolResult(result) {
  return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
}
