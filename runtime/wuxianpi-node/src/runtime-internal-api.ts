import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { PackageRuntimeHostV1, PackageServiceRefV1 } from "./package-runtime-host.js";
import { RequestError, stringifyMessage } from "./protocol.js";

const API_ROOT = "/api/runtime/v1";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class RuntimeInternalApi {
  constructor(private readonly options: { packageRuntimeHost: PackageRuntimeHostV1; token: string }) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (!url.pathname.startsWith(`${API_ROOT}/`) && url.pathname !== API_ROOT) return false;
    try {
      if (url.pathname === `${API_ROOT}/package-services/invoke` && request.method === "POST") {
        this.authorize(request);
        const body = await readJsonBody(request);
        const reference = serviceReference(body.reference);
        const result = await this.options.packageRuntimeHost.invokeServiceLocal(reference, body.input, true);
        json(response, 200, { ok: true, data: { result } });
        return true;
      }
      if (url.pathname === `${API_ROOT}/singletons` && request.method === "GET") {
        const singletons = await this.listSingletons();
        json(response, 200, { ok: true, data: { singletons } });
        return true;
      }
      const match = /^\/api\/runtime\/v1\/singletons\/([^/]+)(?:\/(acquire|release))?$/.exec(url.pathname);
      if (match) {
        const groupId = decodeURIComponent(match[1]!);
        if (!match[2] && request.method === "GET") {
          const singleton = this.options.packageRuntimeHost.singletons().find((item) => item.groupId === groupId);
          if (!singleton) throw new RequestError("singleton_not_found", `Package singleton group not found: ${groupId}`, { httpStatus: 404 });
          const discoveredOwner = singleton.owner === true ? null : await this.options.packageRuntimeHost.discoverSingletonOwner(groupId);
          json(response, 200, { ok: true, data: { singleton: { ...singleton, discoveredOwner } } });
          return true;
        }
        if (match[2] && request.method === "POST") {
          const singleton = match[2] === "acquire"
            ? await this.options.packageRuntimeHost.acquireSingleton(groupId)
            : await this.options.packageRuntimeHost.releaseSingleton(groupId);
          const owner = singleton.owner === true ? null : await this.options.packageRuntimeHost.discoverSingletonOwner(groupId);
          const acquired = match[2] !== "acquire" || singleton.owner === true;
          json(response, acquired ? 200 : 409, acquired
            ? { ok: true, data: { singleton, owner } }
            : { ok: false, error: { code: "singleton_guard_occupied", message: "Another Runtime owns this Package singleton group", details: { singleton, owner } } });
          return true;
        }
      }
      json(response, 404, { ok: false, error: { code: "not_found", message: "Runtime API route not found" } });
    } catch (error) {
      const details = error instanceof RequestError && error.details && typeof error.details === "object"
        ? error.details as { httpStatus?: unknown } : undefined;
      const status = typeof details?.httpStatus === "number" ? details.httpStatus : 500;
      json(response, status, { ok: false, error: {
        code: error instanceof RequestError ? error.code : "runtime_error",
        message: error instanceof Error ? error.message : String(error),
      } });
    }
    return true;
  }

  private async listSingletons(): Promise<Record<string, unknown>[]> {
    return Promise.all(this.options.packageRuntimeHost.singletons().map(async (singleton) => ({
      ...singleton,
      discoveredOwner: singleton.owner === true ? null : await this.options.packageRuntimeHost.discoverSingletonOwner(String(singleton.groupId)),
    })));
  }

  private authorize(request: IncomingMessage): void {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([^\s]+)$/.exec(header) : null;
    if (!match?.[1] || !secretMatches(match[1], this.options.token)) {
      throw new RequestError("runtime_internal_unauthorized", "Valid Runtime internal bearer token required", { httpStatus: 401 });
    }
  }
}

export function loadOrCreateRuntimeInternalToken(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const generated = randomBytes(32).toString("hex");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${generated}\n`, "utf8");
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readFileSync(path, "utf8").trim();
    if (!existing) throw new Error("Runtime internal token file is empty");
    return existing;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    chmodSync(path, 0o600);
  }
}

function serviceReference(value: unknown): PackageServiceRefV1 {
  if (!value || typeof value !== "object") throw new RequestError("invalid_service_reference", "Package service reference is required", { httpStatus: 400 });
  const record = value as Record<string, unknown>;
  for (const field of ["packageId", "serviceId", "method"] as const) {
    if (typeof record[field] !== "string" || !record[field].trim()) {
      throw new RequestError("invalid_service_reference", `Package service ${field} is required`, { httpStatus: 400 });
    }
  }
  return { packageId: String(record.packageId), serviceId: String(record.serviceId), method: String(record.method) };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new RequestError("request_too_large", "Runtime internal request body is too large", { httpStatus: 413 });
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch {
    throw new RequestError("invalid_json", "Runtime internal request body must be a JSON object", { httpStatus: 400 });
  }
}

function secretMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = stringifyMessage(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
  });
  response.end(encoded);
}
