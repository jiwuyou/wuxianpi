import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HubService } from "./service.js";
import { HubError } from "./errors.js";
import type { IssueActor, PublisherCredential } from "./types.js";
import type { VerifiedAssetStore } from "./metadata.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(bytes);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 1024 * 1024) throw new HubError(413, "request_too_large", "JSON request body exceeds 1 MiB");
    chunks.push(bytes);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HubError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function bearer(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice(7);
}

function routeParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((item) => {
    try { return decodeURIComponent(item); }
    catch { throw new HubError(400, "invalid_path", "URL path contains invalid encoding"); }
  });
}

function requireText(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as Record<string, unknown>)[key] !== "string" || !(body as Record<string, string>)[key]?.trim()) {
    throw new HubError(400, "invalid_request", `${key} is required`);
  }
  return (body as Record<string, string>)[key]!.trim();
}

export interface HubServerOptions {
  service: HubService;
  publicDir: string;
  adminToken: string;
  publisherCredentials: Map<string, PublisherCredential>;
  assetStore: VerifiedAssetStore;
}

export function createHubServer(options: HubServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      await routeRequest(options, request, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (error instanceof HubError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        console.error(error);
        sendJson(response, 500, { error: { code: "internal_error", message: "The Hub could not complete the request." } });
      }
    }
  });
}

async function routeRequest(options: HubServerOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";
  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "wuxianpi-hub", time: new Date().toISOString() }, { "cache-control": "no-store" });
    return;
  }

  const parts = routeParts(url.pathname);
  if (parts[0] === "api" && parts[1] === "v1") {
    await routeApi(options, request, response, method, parts.slice(2), url.searchParams);
    return;
  }

  if (method !== "GET" && method !== "HEAD") throw new HubError(405, "method_not_allowed", "Method is not allowed");
  await serveStatic(options.publicDir, url.pathname, method === "HEAD", response);
}

async function routeApi(
  options: HubServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  parts: string[],
  query: URLSearchParams,
): Promise<void> {
  const { service } = options;

  if (method === "GET" && parts.length === 2 && parts[0] === "assets") {
    const asset = await options.assetStore.get(parts[1]!);
    if (!asset) throw new HubError(404, "asset_not_found", "The verified asset does not exist");
    response.writeHead(200, {
      "content-type": asset.mediaType,
      "content-length": String(asset.bytes.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    });
    response.end(asset.bytes);
    return;
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "packages") {
    sendJson(response, 200, service.listPackages(query), { "cache-control": "public, max-age=30" });
    return;
  }

  if (parts[0] === "issues") {
    const actor = authenticateIssueActor(options, bearer(request));
    if (parts.length === 1 && method === "GET") {
      sendJson(response, 200, service.listIssues(actor, query), { "cache-control": "no-store" });
      return;
    }
    if (parts.length === 1 && method === "POST") {
      sendJson(response, 201, service.createIssue(actor, await readJson(request)), { "cache-control": "no-store" });
      return;
    }
    if (parts[1]) {
      const issueId = parts[1];
      if (parts.length === 2 && method === "GET") {
        sendJson(response, 200, service.getIssue(actor, issueId), { "cache-control": "no-store" });
        return;
      }
      if (parts.length === 3 && parts[2] === "comments" && method === "POST") {
        sendJson(response, 201, service.commentIssue(actor, issueId, await readJson(request)), { "cache-control": "no-store" });
        return;
      }
      if (parts.length === 3 && parts[2] === "status" && method === "PATCH") {
        sendJson(response, 200, service.updateIssueStatus(actor, issueId, await readJson(request)), { "cache-control": "no-store" });
        return;
      }
      if (parts.length === 3 && parts[2] === "external-links" && method === "POST") {
        sendJson(response, 200, service.linkIssueToGithub(actor, issueId, await readJson(request)), { "cache-control": "no-store" });
        return;
      }
      if (parts.length === 3 && parts[2] === "verify" && method === "POST") {
        sendJson(response, 200, service.verifyIssue(actor, issueId, await readJson(request)), { "cache-control": "no-store" });
        return;
      }
    }
  }
  if (parts[0] === "packages" && parts[1]) {
    const packageId = parts[1];
    if (method === "GET" && parts.length === 2) {
      sendJson(response, 200, service.getPackage(packageId), { "cache-control": "public, max-age=30" });
      return;
    }
    if (method === "GET" && parts.length === 3 && parts[2] === "releases") {
      sendJson(response, 200, service.listReleases(packageId, query), { "cache-control": "public, max-age=30" });
      return;
    }
    if (method === "GET" && parts.length === 3 && parts[2] === "install-plan") {
      sendJson(response, 200, service.getInstallPlan(packageId, query), { "cache-control": "public, max-age=300, immutable" });
      return;
    }
  }

  if (parts[0] === "publisher") {
    const publisher = authenticatePublisher(options.publisherCredentials, bearer(request));
    if (method === "POST" && parts.length === 2 && parts[1] === "submissions") {
      sendJson(response, 202, { submission: await service.createSubmission(publisher, await readJson(request)) }, { "cache-control": "no-store" });
      return;
    }
    if (parts[1] === "submissions" && parts[2]) {
      const submissionId = parts[2];
      if (method === "GET" && parts.length === 3) {
        sendJson(response, 200, { submission: service.getSubmission(publisher.id, submissionId) }, { "cache-control": "no-store" });
        return;
      }
      if (method === "PATCH" && parts.length === 3) {
        sendJson(response, 200, { submission: await service.updateSubmission(publisher.id, submissionId, await readJson(request)) }, { "cache-control": "no-store" });
        return;
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "sync") {
        sendJson(response, 202, { submission: await service.syncSubmission(publisher.id, submissionId) }, { "cache-control": "no-store" });
        return;
      }
    }
  }

  if (parts[0] === "admin") {
    authenticateAdmin(options.adminToken, bearer(request));
    if (method === "POST" && parts[1] === "submissions" && parts[2] && parts[3] === "approve") {
      const body = await readJson(request);
      const notes = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).notes === "string"
        ? (body as Record<string, string>).notes! : null;
      sendJson(response, 201, await service.approveSubmission(parts[2]!, notes, "admin"), { "cache-control": "no-store" });
      return;
    }
    if (method === "POST" && parts[1] === "submissions" && parts[2] && parts[3] === "reject") {
      const body = await readJson(request);
      service.rejectSubmission(parts[2]!, requireText(body, "reason"), "admin");
      sendJson(response, 200, { submissionId: parts[2], status: "rejected" }, { "cache-control": "no-store" });
      return;
    }
    if (method === "POST" && parts[1] === "releases" && parts[2] && parts[3] === "revoke") {
      const body = await readJson(request);
      service.revokeRelease(parts[2]!, requireText(body, "reason"), "admin");
      sendJson(response, 200, { releaseId: parts[2], status: "revoked" }, { "cache-control": "no-store" });
      return;
    }
  }

  throw new HubError(404, "route_not_found", "The requested Hub route does not exist");
}

function authenticatePublisher(credentials: Map<string, PublisherCredential>, token: string | null): PublisherCredential {
  if (!token) throw new HubError(401, "publisher_auth_required", "Publisher bearer token is required");
  for (const credential of credentials.values()) if (credential.token === token) return credential;
  throw new HubError(403, "publisher_auth_invalid", "Publisher bearer token is invalid");
}

function authenticateAdmin(expected: string, token: string | null): void {
  if (!expected) throw new HubError(503, "admin_not_configured", "Hub administrator token is not configured");
  if (!token) throw new HubError(401, "admin_auth_required", "Administrator bearer token is required");
  if (token !== expected) throw new HubError(403, "admin_auth_invalid", "Administrator bearer token is invalid");
}

function authenticateIssueActor(options: HubServerOptions, token: string | null): IssueActor {
  if (!token) return { kind: "anonymous" };
  if (options.adminToken && token === options.adminToken) return { kind: "admin", id: "admin", name: "WuxianPi Hub 管理员" };
  for (const publisher of options.publisherCredentials.values()) {
    if (publisher.token === token) return { kind: "publisher", id: publisher.id, name: publisher.name };
  }
  if (token.length < 24 || token.length > 512) throw new HubError(403, "issue_auth_invalid", "Issue bearer token is invalid");
  return { kind: "reporter", tokenHash: createHash("sha256").update(token).digest("hex") };
}

async function serveStatic(publicDir: string, pathname: string, head: boolean, response: ServerResponse): Promise<void> {
  const decoded = decodeURIComponent(pathname);
  const requested = decoded === "/" ? "index.html" : normalize(decoded).replace(/^[/\\]+/, "");
  let file = resolve(publicDir, requested);
  const rel = relative(publicDir, file);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new HubError(404, "not_found", "Asset not found");
  try {
    const stat = await lstat(file);
    if (stat.isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(publicDir, "index.html");
  }
  const stat = await lstat(file).catch(() => null);
  if (!stat?.isFile()) throw new HubError(404, "not_found", "Asset not found");
  response.writeHead(200, {
    "content-type": MIME_TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": String(stat.size),
    "cache-control": extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
    "content-security-policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  if (head) response.end();
  else createReadStream(file).pipe(response);
}
