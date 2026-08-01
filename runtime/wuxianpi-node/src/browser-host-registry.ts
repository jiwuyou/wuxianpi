import { randomUUID } from "node:crypto";
import {
  BROWSER_HOST_PROTOCOL,
  BROWSER_HOST_PROTOCOL_VERSION,
  type BrowserHostEventMessage,
  type BrowserHostRegistration,
  type BrowserHostResultMessage,
  type BrowserInvocationInput,
  type BrowserInvokeMessage,
  type BrowserJsonObject,
  type BrowserTabSnapshot,
  normalizeBrowserInvocation,
} from "./browser-host-protocol.js";
import { RequestError } from "./protocol.js";

export interface BrowserHostConnection {
  id: string;
  remoteAddress?: string;
  send(message: BrowserInvokeMessage | BrowserJsonObject): void;
  close(code: number, reason: string): void;
}

export interface BrowserHostSnapshot {
  hostId: string;
  connectionId: string;
  connectedAt: string;
  updatedAt: string;
  remoteAddress?: string;
  priority: number;
  preferred: boolean;
  implementationVersion?: string;
  capabilities: BrowserJsonObject;
  tabs: BrowserTabSnapshot[];
  context?: BrowserJsonObject | null;
  recentEvents: BrowserHostEventMessage[];
  pendingRequests: number;
}

export interface BrowserInvocationResult {
  requestId: string;
  hostId: string;
  result: unknown;
}

interface HostRecord {
  registration: BrowserHostRegistration;
  connection: BrowserHostConnection;
  connectedAt: number;
  updatedAt: number;
  priority: number;
  tabs: BrowserTabSnapshot[];
  context?: BrowserJsonObject | null;
  events: BrowserHostEventMessage[];
}

interface PendingRequest {
  requestId: string;
  hostId: string;
  connectionId: string;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
  resolve(value: BrowserInvocationResult): void;
  reject(error: unknown): void;
}

export interface BrowserHostRegistryOptions {
  defaultTimeoutMs?: number;
  maxEventsPerHost?: number;
}

export class BrowserHostRegistry {
  private readonly hosts = new Map<string, HostRecord>();
  private readonly hostByConnection = new Map<string, string>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly defaultTimeoutMs: number;
  private readonly maxEventsPerHost: number;

  constructor(options: BrowserHostRegistryOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxEventsPerHost = options.maxEventsPerHost ?? 50;
  }

  register(connection: BrowserHostConnection, registration: BrowserHostRegistration): BrowserHostSnapshot {
    const priorHostId = this.hostByConnection.get(connection.id);
    if (priorHostId && priorHostId !== registration.hostId) {
      const priorRecord = this.hosts.get(priorHostId);
      if (priorRecord?.connection.id === connection.id) this.hosts.delete(priorHostId);
      this.rejectPendingForConnection(connection.id, "browser_host_replaced", `Browser host connection changed identity to ${registration.hostId}`);
    }
    const previous = this.hosts.get(registration.hostId);
    if (previous && previous.connection.id !== connection.id) {
      this.rejectPendingForConnection(previous.connection.id, "browser_host_replaced", `Browser host ${registration.hostId} reconnected`);
      this.hostByConnection.delete(previous.connection.id);
      previous.connection.close(4001, "browser host replaced");
    }
    const now = Date.now();
    const record: HostRecord = {
      registration,
      connection,
      connectedAt: now,
      updatedAt: now,
      priority: registration.priority ?? defaultPriority(registration.hostId),
      tabs: registration.tabs,
      ...(registration.context === undefined && previous?.context === undefined ? {} : {
        context: registration.context === undefined ? previous?.context : registration.context,
      }),
      events: previous?.events ?? [],
    };
    this.hosts.set(registration.hostId, record);
    this.hostByConnection.set(connection.id, registration.hostId);
    return this.snapshot(record);
  }

  disconnect(connectionId: string, reason = "Browser host disconnected"): void {
    const hostId = this.hostByConnection.get(connectionId);
    this.hostByConnection.delete(connectionId);
    if (!hostId) return;
    const current = this.hosts.get(hostId);
    if (!current || current.connection.id !== connectionId) return;
    this.hosts.delete(hostId);
    this.rejectPendingForConnection(connectionId, "browser_host_disconnected", reason);
  }

  acceptResult(connectionId: string, message: BrowserHostResultMessage): boolean {
    const pending = this.pending.get(message.id);
    if (!pending || pending.connectionId !== connectionId) return false;
    this.clearPending(pending);
    if (message.ok) {
      pending.resolve({ requestId: pending.requestId, hostId: pending.hostId, result: message.result });
    } else {
      const error = message.error!;
      pending.reject(new RequestError(error.code || "browser_action_failed", error.message || "Browser action failed", {
        hostId: pending.hostId,
        requestId: pending.requestId,
        remoteDetails: error.details,
      }));
    }
    return true;
  }

  acceptEvent(connectionId: string, event: BrowserHostEventMessage): BrowserHostSnapshot {
    const record = this.requireConnection(connectionId);
    record.updatedAt = Date.now();
    if (event.tabs !== undefined) record.tabs = event.tabs;
    if (event.context !== undefined) record.context = event.context;
    const dataTabs = event.data?.tabs;
    if (event.tabs === undefined && Array.isArray(dataTabs)) {
      record.tabs = dataTabs.filter(isRecord).filter((tab) => typeof tab.tabId === "string") as BrowserTabSnapshot[];
    }
    if (event.context === undefined && event.data && Object.prototype.hasOwnProperty.call(event.data, "context")) {
      const context = event.data.context;
      if (context === null || isRecord(context)) record.context = context;
    }
    record.events.push(event);
    if (record.events.length > this.maxEventsPerHost) record.events.splice(0, record.events.length - this.maxEventsPerHost);
    return this.snapshot(record);
  }

  async invoke(input: BrowserInvocationInput): Promise<BrowserInvocationResult> {
    const normalized = normalizeBrowserInvocation(input);
    const requestedHostId = normalized.hostId ?? normalized.target?.hostId;
    const record = requestedHostId ? this.hosts.get(requestedHostId) : this.preferredRecord();
    if (!record) {
      throw new RequestError("browser_host_offline", requestedHostId
        ? `Browser host is not connected: ${requestedHostId}` : "No Browser Host is connected", { httpStatus: 503, hostId: requestedHostId });
    }
    const requestId = randomUUID();
    const timeoutMs = normalized.timeoutMs ?? this.defaultTimeoutMs;
    const target = { ...(normalized.target ?? {}), hostId: record.registration.hostId };
    const message: BrowserInvokeMessage = {
      type: "browser.invoke",
      protocol: BROWSER_HOST_PROTOCOL,
      protocolVersion: BROWSER_HOST_PROTOCOL_VERSION,
      id: requestId,
      method: normalized.method,
      target,
      params: normalized.params ?? {},
    };
    if (input.signal?.aborted) throw new RequestError("browser_request_aborted", "Browser request was aborted", { requestId });

    return new Promise<BrowserInvocationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.clearPending(pending);
        reject(new RequestError("browser_host_timeout", `Browser host did not respond within ${timeoutMs}ms`, {
          httpStatus: 504, hostId: pending.hostId, requestId,
        }));
      }, timeoutMs);
      timer.unref();
      const pending: PendingRequest = {
        requestId,
        hostId: record.registration.hostId,
        connectionId: record.connection.id,
        timer,
        resolve,
        reject,
      };
      if (input.signal) {
        const onAbort = () => {
          if (!this.pending.has(requestId)) return;
          this.clearPending(pending);
          reject(new RequestError("browser_request_aborted", "Browser request was aborted", { hostId: pending.hostId, requestId }));
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        pending.abortCleanup = () => input.signal?.removeEventListener("abort", onAbort);
      }
      this.pending.set(requestId, pending);
      try { record.connection.send(message); }
      catch (error) {
        this.clearPending(pending);
        reject(new RequestError("browser_host_send_failed", "Unable to send request to Browser Host", {
          httpStatus: 503, hostId: pending.hostId, requestId, cause: error instanceof Error ? error.message : String(error),
        }));
      }
    });
  }

  describe(): { protocol: string; protocolVersion: number; preferredHostId: string | null; hosts: BrowserHostSnapshot[] } {
    const preferred = this.preferredRecord();
    return {
      protocol: BROWSER_HOST_PROTOCOL,
      protocolVersion: BROWSER_HOST_PROTOCOL_VERSION,
      preferredHostId: preferred?.registration.hostId ?? null,
      hosts: this.sortedRecords().map((record) => this.snapshot(record, preferred?.registration.hostId)),
    };
  }

  close(): void {
    for (const record of this.hosts.values()) record.connection.close(1001, "runtime stopping");
    for (const pending of [...this.pending.values()]) {
      this.clearPending(pending);
      pending.reject(new RequestError("browser_host_disconnected", "Runtime is stopping", {
        httpStatus: 503, hostId: pending.hostId, requestId: pending.requestId,
      }));
    }
    this.hosts.clear();
    this.hostByConnection.clear();
  }

  private preferredRecord(): HostRecord | undefined { return this.sortedRecords()[0]; }

  private sortedRecords(): HostRecord[] {
    return [...this.hosts.values()].sort((left, right) =>
      right.priority - left.priority || builtInPreference(right.registration.hostId) - builtInPreference(left.registration.hostId) ||
      right.connectedAt - left.connectedAt || left.registration.hostId.localeCompare(right.registration.hostId));
  }

  private snapshot(record: HostRecord, preferredHostId = this.preferredRecord()?.registration.hostId): BrowserHostSnapshot {
    return {
      hostId: record.registration.hostId,
      connectionId: record.connection.id,
      connectedAt: new Date(record.connectedAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
      ...(record.connection.remoteAddress ? { remoteAddress: record.connection.remoteAddress } : {}),
      priority: record.priority,
      preferred: record.registration.hostId === preferredHostId,
      ...(record.registration.implementationVersion ? { implementationVersion: record.registration.implementationVersion } : {}),
      capabilities: record.registration.capabilities,
      tabs: record.tabs,
      ...(record.context === undefined ? {} : { context: record.context }),
      recentEvents: [...record.events],
      pendingRequests: [...this.pending.values()].filter((pending) => pending.connectionId === record.connection.id).length,
    };
  }

  private requireConnection(connectionId: string): HostRecord {
    const hostId = this.hostByConnection.get(connectionId);
    const record = hostId ? this.hosts.get(hostId) : undefined;
    if (!record || record.connection.id !== connectionId) {
      throw new RequestError("browser_host_not_registered", "Browser Host connection must register before sending results or events");
    }
    return record;
  }

  private rejectPendingForConnection(connectionId: string, code: string, message: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.connectionId !== connectionId) continue;
      this.clearPending(pending);
      pending.reject(new RequestError(code, message, {
        httpStatus: 503, hostId: pending.hostId, requestId: pending.requestId,
      }));
    }
  }

  private clearPending(pending: PendingRequest): void {
    this.pending.delete(pending.requestId);
    clearTimeout(pending.timer);
    pending.abortCleanup?.();
  }
}

function defaultPriority(hostId: string): number {
  if (hostId === "native-browser") return 200;
  if (hostId === "all-in-one") return 100;
  return 0;
}

function builtInPreference(hostId: string): number {
  if (hostId === "native-browser") return 2;
  if (hostId === "all-in-one") return 1;
  return 0;
}

function isRecord(value: unknown): value is BrowserJsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
