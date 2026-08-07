import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { AutomationTurnService } from "./automation-turn-service.js";
import { AUTOMATION_API_ROOT } from "./automation-turn-types.js";
import { RequestError, stringifyMessage } from "./protocol.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface AutomationApiOptions {
  service: AutomationTurnService;
  ownerToken: string;
}

export class AutomationApi {
  constructor(private readonly options: AutomationApiOptions) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== AUTOMATION_API_ROOT && !url.pathname.startsWith(`${AUTOMATION_API_ROOT}/`)) return false;
    try {
      await this.route(request, response, url);
    } catch (error) {
      if (response.headersSent) response.end();
      else json(response, statusFor(error), {
        ok: false,
        error: {
          code: error instanceof RequestError ? error.code : "runtime_error",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof RequestError && error.details !== undefined ? { details: error.details } : {}),
        },
      });
    }
    return true;
  }

  private async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    const suffix = url.pathname.slice(AUTOMATION_API_ROOT.length);
    const parts = suffix.split("/").filter(Boolean).map(decodePathPart);

    if (parts.length === 1 && parts[0] === "bindings" && method === "POST") {
      this.requireOwner(request);
      const body = await readJsonBody(request);
      const result = await this.options.service.createBinding({
        taskId: requiredString(body, "taskId"),
        conversationId: requiredString(body, "conversationId"),
        taskRoot: requiredString(body, "taskRoot"),
      });
      json(response, 201, { ok: true, data: result });
      return;
    }
    if (parts.length === 2 && parts[0] === "bindings" && method === "DELETE") {
      this.requireOwner(request);
      json(response, 200, { ok: true, data: { binding: this.options.service.revokeBinding(parts[1] ?? "") } });
      return;
    }
    if (parts.length === 1 && parts[0] === "messages" && method === "POST") {
      const taskToken = bearerToken(request);
      const body = await readJsonBody(request);
      const result = await this.options.service.appendMessage({
        taskToken,
        taskId: requiredString(body, "taskId"),
        runId: requiredString(body, "runId"),
        conversationId: optionalString(body, "conversationId"),
        message: requiredString(body, "message"),
        artifactRefs: body.artifactRefs,
      });
      json(response, 201, { ok: true, data: result });
      return;
    }
    if (parts.length === 1 && parts[0] === "turns" && method === "POST") {
      const taskToken = bearerToken(request);
      const body = await readJsonBody(request);
      const result = await this.options.service.triggerTurn({
        taskToken,
        taskId: requiredString(body, "taskId"),
        runId: requiredString(body, "runId"),
        conversationId: optionalString(body, "conversationId"),
        message: requiredString(body, "message"),
        artifactRefs: body.artifactRefs,
        idempotencyKey: requiredString(body, "idempotencyKey"),
      });
      json(response, result.status === "queued" ? 202 : 200, { ok: true, data: { turn: result } });
      return;
    }
    if (parts.length === 2 && parts[0] === "turns" && method === "GET") {
      const waitMs = optionalIntegerQuery(url, "waitMs", 0);
      const result = await this.options.service.getTurn(parts[1] ?? "", bearerToken(request), waitMs);
      json(response, 200, { ok: true, data: { turn: result } });
      return;
    }
    if (parts.length === 3 && parts[0] === "turns" && parts[2] === "cancel" && method === "POST") {
      const result = this.options.service.cancelTurn(parts[1] ?? "", bearerToken(request));
      json(response, 200, { ok: true, data: { turn: result } });
      return;
    }
    throw new RequestError("not_found", `Automation API route not found: ${method} ${url.pathname}`);
  }

  private requireOwner(request: IncomingMessage): void {
    if (!secretMatches(bearerToken(request), this.options.ownerToken)) {
      throw new RequestError("automation_owner_unauthorized", "Invalid automation owner token", { httpStatus: 401 });
    }
  }
}

export function loadOrCreateAutomationOwnerToken(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const generated = randomBytes(32).toString("base64url");
    try { writeFileSync(path, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch (writeError) {
      if (!isAlreadyExists(writeError)) throw writeError;
    }
    token = readFileSync(path, "utf8").trim();
  }
  if (!token) throw new RequestError("automation_owner_token_invalid", "Automation owner token file is empty");
  chmodSync(path, 0o600);
  return token;
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^Bearer ([^\s]+)$/.exec(header) : null;
  if (!match?.[1]) throw new RequestError("automation_unauthorized", "Bearer token is required", { httpStatus: 401 });
  return match[1];
}

function secretMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new RequestError("payload_too_large", "Request body exceeds 2 MiB");
    chunks.push(buffer);
  }
  if (bytes === 0) return {};
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError("invalid_json", "Request body must be valid JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError("invalid_payload", "Request body must be an object");
  }
  return body as Record<string, unknown>;
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

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError("invalid_payload", `${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new RequestError("invalid_payload", `${name} must be a string`);
  return value;
}

function optionalIntegerQuery(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new RequestError("invalid_payload", `${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new RequestError("invalid_payload", `${name} is too large`);
  return value;
}

function decodePathPart(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new RequestError("invalid_path", "Automation API path contains invalid encoding"); }
}

function statusFor(error: unknown): number {
  if (!(error instanceof RequestError)) return 500;
  if (isRecord(error.details) && typeof error.details.httpStatus === "number") return error.details.httpStatus;
  if (error.code.endsWith("_not_found") || error.code === "not_found") return 404;
  if (error.code.includes("conflict") || error.code === "automation_turn_not_active") return 409;
  return 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
