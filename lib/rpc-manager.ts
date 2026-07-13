import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import { cacheSessionPath } from "./session-reader";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type { ExtensionUiRequest, ExtensionUiResponse, ExtensionWidgetItem } from "./types";
import type { CapabilityDiagnostic } from "./wuxianpi/contracts";
import { readFile } from "node:fs/promises";
import path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const extensionToolNames = session
    .getAllTools()
    .map((t) => t.name)
    .filter((name) => !codingToolNames.has(name));

  return [...new Set([...toolNames, ...extensionToolNames])];
}

const SAFE_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const BUILTIN_TOOLS = new Set(CODING_TOOL_NAMES);

function createPermissionGuard(assistantId: string, selfGuardedTools: Set<string>): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (selfGuardedTools.has(event.toolName)) return;
      const capabilityId = BUILTIN_TOOLS.has(event.toolName) ? `pi:${event.toolName}` : `pi-extension:${event.toolName}`;
      const permissions = await import("./wuxianpi/permission-manager");
      const decision = SAFE_READ_TOOLS.has(event.toolName)
        ? await permissions.getPermissionDecision(assistantId, capabilityId)
        : await permissions.consumePermissionDecision(assistantId, capabilityId);
      if (decision === "deny" || (!decision && !SAFE_READ_TOOLS.has(event.toolName))) {
        return { block: true, reason: decision === "deny" ? `Permission denied for ${event.toolName}` : `Permission required for ${event.toolName}` };
      }
    });
  };
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private extensionWorkingState: Record<string, unknown> = {};
  private toolsExpanded = false;
  private promptRunning = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private lastActivityAt = Date.now();

  constructor(
    public readonly inner: AgentSessionLike,
    private readonly idleTimeoutMs = 10 * 60 * 1000,
    private readonly strictToolSelection = false,
    private readonly alwaysActiveToolNames: string[] = [],
    private readonly allowedToolNames = new Set<string>(),
    private readonly runtimeDiagnostics: CapabilityDiagnostic[] = [],
  ) {
    this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  isBusy(): boolean { return this.promptRunning || this.inner.isStreaming || this.inner.isCompacting; }
  getLastActivityAt(): number { return this.lastActivityAt; }
  getCwd(): string { return this.inner.sessionManager.getCwd(); }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      this.emit(event);
    });
    this.resetIdleTimer();
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private resetIdleTimer(): void {
    this.lastActivityAt = Date.now();
    this.scheduleIdleTimer();
  }

  private scheduleIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isBusy()) this.scheduleIdleTimer();
      else this.destroy();
    }, this.idleTimeoutMs);
  }

  private refreshModelRuntime(): void {
    try {
      const registry = this.inner.modelRegistry;
      registry.authStorage?.reload?.();
      registry.refresh?.();
    } catch (error) {
      console.warn("Failed to refresh model runtime:", error);
    }
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;

    switch (type) {
      case "prompt": {
        // Fire and forget — events come via subscribe
        this.refreshModelRuntime();
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        this.promptRunning = true;
        this.inner.prompt(command.message as string, {
          ...(promptImages?.length ? { images: promptImages } : {}),
          ...(streamingBehavior ? { streamingBehavior } : {}),
          source: "rpc",
        }).then(() => {
          this.promptRunning = false;
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
        }).catch((error) => {
          this.promptRunning = false;
          this.emit({
            type: "prompt_error",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
        });
        return null;
      }

      case "abort":
        await this.inner.abort();
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: 0,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
          extensionWorkingState: this.extensionWorkingState,
          runtimeDiagnostics: this.runtimeDiagnostics,
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        this.refreshModelRuntime();
        const registry = this.inner.modelRegistry;
        const model = registry.find(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        return null;
      }

      case "compact": {
        const result = await this.inner.compact(command.customInstructions as string | undefined);
        return result;
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        const requested = command.toolNames as string[];
        const permitted = this.strictToolSelection ? requested.filter((name) => this.allowedToolNames.has(name)) : requested;
        this.inner.setActiveToolsByName(this.strictToolSelection ? [...new Set([...permitted, ...this.alwaysActiveToolNames])] : withExtensionTools(this.inner, permitted));
        return null;
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    this.pendingUiResponses.clear();
    this.onDestroyCallback?.();
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: (message) => { this.extensionWorkingState.message = message; this.emit({ type: "extension_ui_request", id: randomUUID(), method: "setWorkingMessage", message }); },
      setWorkingVisible: (visible) => { this.extensionWorkingState.visible = visible; this.emit({ type: "extension_ui_request", id: randomUUID(), method: "setWorkingVisible", visible }); },
      setWorkingIndicator: (options) => { this.extensionWorkingState.indicator = options; this.emit({ type: "extension_ui_request", id: randomUUID(), method: "setWorkingIndicator", options }); },
      setHiddenThinkingLabel: (label) => { this.extensionWorkingState.hiddenThinkingLabel = label; this.emit({ type: "extension_ui_request", id: randomUUID(), method: "setHiddenThinkingLabel", label }); },
      setWidget: (key, content, options) => {
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.extensionWidgets.delete(key);
        } else {
          this.extensionWidgets.set(key, {
            key,
            lines: content,
            placement: options?.placement ?? "aboveEditor",
          });
        }
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: async <T = unknown>() => undefined as T,
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return undefined; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in WuxianPi extension UI yet" }),
      getToolsExpanded: () => this.toolsExpanded,
      setToolsExpanded: (expanded) => { this.toolsExpanded = expanded; this.emit({ type: "extension_ui_request", id: randomUUID(), method: "setToolsExpanded", expanded }); },
    };
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export function destroyRpcSessionsForAssistant(assistantId: string): void {
  for (const session of getRegistry().values()) {
    const cwd = session.getCwd();
    if (cwd.endsWith(`/assistants/${assistantId}`) || cwd.endsWith(`\\assistants\\${assistantId}`)) session.destroy();
  }
}

export interface StartRpcSessionOptions {
  toolNames?: string[];
  skillNames?: string[];
  customTools?: ToolDefinition[];
  idleSessionMs?: number;
  maxLiveSessions?: number;
  strictToolSelection?: boolean;
  assistantContextFiles?: string[];
  permissionAssistantId?: string;
  runtimeDiagnostics?: CapabilityDiagnostic[];
}

export function evictExcessSessions(registry: Map<string, AgentSessionWrapper>, maxLiveSessions: number, keepId: string): void {
  const overflow = registry.size - Math.max(1, maxLiveSessions);
  if (overflow <= 0) return;
  const candidates = Array.from(registry.entries())
    .filter(([id, session]) => id !== keepId && !session.isBusy())
    .sort((a, b) => a[1].getLastActivityAt() - b[1].getLastActivityAt());
  for (let index = 0; index < Math.min(overflow, candidates.length); index++) candidates[index][1].destroy();
}

export function getPiNoToolsMode(toolNames: string[] | undefined, customToolCount: number): "all" | "builtin" | undefined {
  return toolNames?.length === 0 ? (customToolCount > 0 ? "builtin" : "all") : undefined;
}

export function normalizeSkillNames(skillNames: string[] | undefined): string[] | undefined {
  return skillNames?.map((name) => name.replace(/^skill:/, ""));
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  optionsOrToolNames?: string[] | StartRpcSessionOptions,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    let options: StartRpcSessionOptions = Array.isArray(optionsOrToolNames) ? { toolNames: optionsOrToolNames } : (optionsOrToolNames ?? {});
    if (optionsOrToolNames === undefined) {
      const [{ assistantIdFromCwd }, { readWuxianPiConfig }] = await Promise.all([import("./wuxianpi/paths"), import("./wuxianpi/config-store")]);
      const config = await readWuxianPiConfig();
      options = { idleSessionMs: config.defaults.idleSessionMs, maxLiveSessions: config.defaults.maxLiveSessions };
      const assistantId = assistantIdFromCwd(cwd);
      if (assistantId) {
        const [{ resolveAssistantRuntime }, { createMcpToolDefinitions }, { createUbuntuToolDefinitions }] = await Promise.all([import("./wuxianpi/runtime-resolver"), import("./wuxianpi/mcp-manager"), import("./wuxianpi/ubuntu-bridge")]);
        const resolved = await resolveAssistantRuntime(assistantId);
        const mcpRuntime = await createMcpToolDefinitions(resolved.mcpServerIds, assistantId);
        const wantsUbuntu = resolved.toolNames.includes("ubuntu:worker");
        const ubuntuRuntime = wantsUbuntu ? await createUbuntuToolDefinitions(assistantId) : { tools: [], diagnostics: [] };
        options = {
          ...options,
          toolNames: resolved.toolNames.filter((name) => name !== "ubuntu:worker"),
          skillNames: resolved.skillNames,
          customTools: [...mcpRuntime.tools, ...ubuntuRuntime.tools],
          strictToolSelection: true,
          assistantContextFiles: ["MEMORY.md", "WORKSPACES.md"],
          permissionAssistantId: assistantId,
          runtimeDiagnostics: [...resolved.diagnostics, ...mcpRuntime.diagnostics, ...ubuntuRuntime.diagnostics],
        };
      }
    }
    const { toolNames, skillNames, customTools = [], idleSessionMs = 10 * 60 * 1000, maxLiveSessions = Number.POSITIVE_INFINITY, strictToolSelection = false, assistantContextFiles = [], permissionAssistantId, runtimeDiagnostics = [] } = options;
    const { SessionManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const agentDir = getAgentDir();

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);

    let resourceLoader: DefaultResourceLoader | undefined;
    if (skillNames !== undefined || assistantContextFiles.length > 0 || permissionAssistantId) {
      const selectedSkills = new Set(normalizeSkillNames(skillNames));
      const appendSystemPrompt: string[] = [];
      for (const filename of assistantContextFiles) {
        if (path.basename(filename) !== filename) throw new Error(`Unsafe assistant context filename: ${filename}`);
        try {
          const content = await readFile(path.join(cwd, filename), "utf8");
          if (content.trim()) appendSystemPrompt.push(`## ${filename}\n\n${content.slice(0, 256 * 1024)}${content.length > 256 * 1024 ? "\n\n[Content truncated by WuxianPi]" : ""}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        ...(skillNames !== undefined ? { skillsOverride: (base: ReturnType<DefaultResourceLoader["getSkills"]>) => ({ ...base, skills: base.skills.filter((skill) => selectedSkills.has(skill.name)) }) } : {}),
        appendSystemPrompt,
        ...(permissionAssistantId ? { extensionFactories: [createPermissionGuard(permissionAssistantId, new Set(customTools.map((tool) => tool.name)))] } : {}),
      });
      await resourceLoader.reload();
    }

    const noTools = getPiNoToolsMode(toolNames, customTools.length);
    const { session: inner } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      ...(noTools ? { noTools } : {}),
      ...(customTools.length ? { customTools } : {}),
      ...(resourceLoader ? { resourceLoader } : {}),
    });

    // If specific tool names were requested (non-empty), set the active tools to the
    // requested builtin coding tools PLUS all extension/package tools, so installed
    // extensions stay usable in WuxianPi just like in the `pi` CLI.
    if (toolNames && (toolNames.length > 0 || customTools.length > 0)) {
      const requested = [...toolNames, ...customTools.map((tool) => tool.name)];
      inner.setActiveToolsByName(strictToolSelection ? requested : (toolNames.length > 0 ? withExtensionTools(inner, toolNames) : customTools.map((tool) => tool.name)));
    }

    const allowedToolNames = new Set([...(toolNames ?? []), ...customTools.map((tool) => tool.name)]);
    const wrapper = new AgentSessionWrapper(inner, idleSessionMs, strictToolSelection, customTools.map((tool) => tool.name), allowedToolNames, runtimeDiagnostics);
    wrapper.start();

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);
    evictExcessSessions(registry, maxLiveSessions, realSessionId);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
