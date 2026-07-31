import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { RequestError } from "./protocol.js";
import { serviceIdOf, unwrapServiceManifest } from "./package-validator.js";

export interface PackageServiceBridge {
  apply(spec: Record<string, unknown>): Promise<string>;
  remove(serviceId: string): Promise<void>;
  exists?(serviceId: string): Promise<boolean>;
  activate?(serviceId: string, restart: boolean): Promise<void>;
  isRunning?(serviceId: string): Promise<boolean>;
}

export interface ServiceManagerClientOptions {
  configPath?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  token?: string;
}

export class ServiceManagerClient implements PackageServiceBridge {
  private readonly configPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrlOverride?: string;
  private readonly tokenOverride?: string;

  constructor(options: ServiceManagerClientOptions = {}) {
    this.configPath = options.configPath ?? join(homedir(), ".config", "openhouseai", "service-manager", "config.json");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrlOverride = options.baseUrl;
    this.tokenOverride = options.token;
  }

  async apply(spec: Record<string, unknown>): Promise<string> {
    const payload = "service" in spec || "schemaVersion" in spec ? unwrapServiceManifest(spec) : spec;
    const id = serviceIdOf(payload);
    if (!id) throw new RequestError("invalid_service_manifest", "Service manifest needs name or id");
    const existing = await this.request("GET", `/api/v1/services/${encodeURIComponent(id)}`, undefined, true);
    await this.request(existing ? "PUT" : "POST", existing ? `/api/v1/services/${encodeURIComponent(id)}` : "/api/v1/services", payload);
    return id;
  }

  async activate(serviceId: string, restart: boolean): Promise<void> {
    if (!restart) await this.request("POST", `/api/v1/services/${encodeURIComponent(serviceId)}/register`);
    await this.request("POST", `/api/v1/services/${encodeURIComponent(serviceId)}/${restart ? "restart" : "start"}`);
  }

  async remove(serviceId: string): Promise<void> {
    await this.request("POST", `/api/v1/services/${encodeURIComponent(serviceId)}/stop`, undefined, true).catch(() => undefined);
    await this.request("POST", `/api/v1/services/${encodeURIComponent(serviceId)}/unregister`, undefined, true).catch(() => undefined);
    await this.request("DELETE", `/api/v1/services/${encodeURIComponent(serviceId)}`, undefined, true);
  }

  async exists(serviceId: string): Promise<boolean> {
    return !!(await this.request("GET", `/api/v1/services/${encodeURIComponent(serviceId)}`, undefined, true));
  }

  async isRunning(serviceId: string): Promise<boolean> {
    const status = await this.request("GET", `/api/v1/services/${encodeURIComponent(serviceId)}/status`, undefined, true);
    return status?.state === "running" || status?.state === "starting";
  }

  private async request(method: string, path: string, body?: unknown, allowNotFound = false): Promise<Record<string, unknown> | undefined> {
    const config = await this.config();
    const response = await this.fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch((error) => { throw new RequestError("service_manager_unavailable", `Unable to reach service-manager: ${error instanceof Error ? error.message : String(error)}`); });
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok) {
      let message = `service-manager returned HTTP ${response.status}`;
      try {
        const payload = await response.json() as { error?: { message?: string } };
        if (payload.error?.message) message = payload.error.message;
      } catch { /* keep HTTP error */ }
      throw new RequestError("service_manager_failed", message);
    }
    if (response.status === 204) return {};
    return await response.json() as Record<string, unknown>;
  }

  private async config(): Promise<{ baseUrl: string; token: string }> {
    if (this.baseUrlOverride && this.tokenOverride) return { baseUrl: this.baseUrlOverride.replace(/\/$/, ""), token: this.tokenOverride };
    let value: Record<string, unknown>;
    try { value = JSON.parse(await readFile(this.configPath, "utf8")) as Record<string, unknown>; }
    catch (error) { throw new RequestError("service_manager_config_unavailable", `Unable to read service-manager config: ${error instanceof Error ? error.message : String(error)}`); }
    const listen = typeof value.listen_addr === "string" && value.listen_addr ? value.listen_addr : "127.0.0.1:20087";
    const token = this.tokenOverride ?? (typeof value.auth_token === "string" ? value.auth_token : "");
    if (!token) throw new RequestError("service_manager_token_missing", "service-manager auth token is missing");
    return { baseUrl: this.baseUrlOverride?.replace(/\/$/, "") ?? `http://${listen}`, token };
  }
}
