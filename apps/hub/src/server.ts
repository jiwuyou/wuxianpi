import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HubAuthService } from "./auth-service.js";
import type { HubDatabase } from "./database.js";
import type { HubService } from "./service.js";
import { HubError } from "./errors.js";
import type {
  AuthenticatedUser,
  GlobalRole,
  HubActor,
  HubUser,
  IssueActor,
  PublisherCredential,
  PublisherIdentity,
  SessionKind,
} from "./types.js";
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

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HubError(400, "invalid_request", "A JSON object is required");
  }
  return body as Record<string, unknown>;
}

function requireBearer(request: IncomingMessage): string {
  const token = bearer(request);
  if (!token) throw new HubError(401, "hub_auth_required", "Hub bearer token is required");
  return token;
}

function sessionRequest(input: Record<string, unknown>, defaultKind: SessionKind): { kind: SessionKind; label?: string } {
  const kind = input.kind === undefined ? defaultKind : input.kind as SessionKind;
  if (input.label !== undefined && typeof input.label !== "string") {
    throw new HubError(400, "invalid_session_label", "label must be a string");
  }
  const label = input.label === undefined ? undefined : input.label;
  return label === undefined ? { kind } : { kind, label };
}

function requireRole(value: unknown): "owner" | "maintainer" | "contributor" {
  if (value !== "owner" && value !== "maintainer" && value !== "contributor") {
    throw new HubError(400, "invalid_package_role", "role must be owner, maintainer, or contributor");
  }
  return value;
}

function requireGlobalRole(value: unknown): GlobalRole {
  if (value !== "user" && value !== "reviewer" && value !== "admin") {
    throw new HubError(400, "invalid_role", "role must be user, reviewer, or admin");
  }
  return value;
}

export interface HubServerOptions {
  service: HubService;
  authService: HubAuthService;
  database: HubDatabase;
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

  if (parts[0] === "auth") {
    if (parts[1] === "github" && parts[2] === "token-exchange" && method === "POST") {
      const body = await readJson(request);
      const input = asObject(body);
      const credential = await options.authService.exchangeGitHubToken(
        requireText(body, "githubToken"),
        sessionRequest(input, "browser"),
      );
      sendJson(response, 200, credential, { "cache-control": "no-store" });
      return;
    }
    if (parts[1] === "github" && parts[2] === "device" && parts[3] === "start" && method === "POST") {
      const authorization = await options.authService.startGitHubDeviceFlow();
      sendJson(response, 200, { authorization }, { "cache-control": "no-store" });
      return;
    }
    if (parts[1] === "github" && parts[2] === "device" && parts[3] === "complete" && method === "POST") {
      const body = await readJson(request);
      const input = asObject(body);
      const credential = await options.authService.completeGitHubDeviceFlow(
        requireText(body, "deviceCode"),
        sessionRequest(input, "device"),
      );
      sendJson(response, 200, credential, { "cache-control": "no-store" });
      return;
    }
    if (parts[1] === "logout" && method === "POST") {
      options.authService.logout(requireBearer(request));
      sendJson(response, 200, { status: "logged_out" }, { "cache-control": "no-store" });
      return;
    }
  }

  if (parts[0] === "me") {
    const token = requireBearer(request);
    if (parts.length === 1 && method === "GET") {
      sendJson(response, 200, options.authService.getMe(token), { "cache-control": "no-store" });
      return;
    }
    if (parts.length === 2 && parts[1] === "sessions" && method === "GET") {
      sendJson(response, 200, { sessions: options.authService.listSessions(token) }, { "cache-control": "no-store" });
      return;
    }
    if (parts.length === 3 && parts[1] === "sessions" && method === "DELETE") {
      options.authService.revokeOwnSession(token, parts[2]!);
      sendJson(response, 200, { sessionId: parts[2], status: "revoked" }, { "cache-control": "no-store" });
      return;
    }
    if (parts.length === 2 && parts[1] === "proposals" && method === "GET") {
      const user = authenticateUser(options, token);
      sendJson(response, 200, service.listContributorProposals(user.user.userId), { "cache-control": "no-store" });
      return;
    }
  }

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
    const publisher = authenticatePublisher(options, bearer(request));
    if (method === "GET" && parts.length === 2 && parts[1] === "submissions") {
      sendJson(response, 200, service.listPublisherSubmissions(publisher.id), { "cache-control": "no-store" });
      return;
    }
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

  if (parts[0] === "reviewer" && parts[1] === "submissions") {
    const reviewer = authenticateUser(options, bearer(request));
    requireReviewer(reviewer);
    if (method === "GET" && parts.length === 2) {
      sendJson(response, 200, service.listReviewerSubmissions(), { "cache-control": "no-store" });
      return;
    }
    if (parts[2] && method === "GET" && parts.length === 3) {
      sendJson(response, 200, service.getSubmissionGovernance(parts[2]), { "cache-control": "no-store" });
      return;
    }
    if (parts[2] && method === "POST" && parts.length === 4 && parts[3] === "review") {
      const body = await readJson(request);
      assertSubmissionRevision(service, parts[2], body);
      sendJson(response, 200, await service.reviewSubmission(parts[2], reviewer.user, body), { "cache-control": "no-store" });
      return;
    }
  }

  if (parts[0] === "submissions" && parts[1] && parts[2] === "reviews" && method === "POST") {
    const reviewer = authenticateUser(options, bearer(request));
    requireReviewer(reviewer);
    const body = await readJson(request);
    assertSubmissionRevision(service, parts[1], body);
    sendJson(response, 200, await service.reviewSubmission(parts[1], reviewer.user, body), { "cache-control": "no-store" });
    return;
  }
  if (parts[0] === "submissions" && parts[1] && parts[2] === "withdraw" && method === "POST") {
    const publisher = authenticatePublisher(options, bearer(request));
    await service.withdrawSubmission(publisher.id, parts[1]);
    sendJson(response, 200, { submissionId: parts[1], status: "withdrawn" }, { "cache-control": "no-store" });
    return;
  }

  if (parts[0] === "packages" && parts[1] && parts[2] === "members") {
    const actor = authenticateUser(options, bearer(request));
    const packageId = parts[1];
    if (method === "GET" && parts.length === 3) {
      requirePackageManager(options, actor.user, packageId);
      sendJson(response, 200, service.listPackageMembers(packageId), { "cache-control": "no-store" });
      return;
    }
    if ((method === "POST" || method === "PUT") && parts.length === 3) {
      const input = asObject(await readJson(request));
      const member = service.upsertPackageMember(actor.user, packageId, requireText(input, "userId"), requireRole(input.role));
      sendJson(response, 200, { member }, { "cache-control": "no-store" });
      return;
    }
    if ((method === "PUT" || method === "PATCH") && parts.length === 4) {
      const input = asObject(await readJson(request));
      const member = service.upsertPackageMember(actor.user, packageId, parts[3]!, requireRole(input.role));
      sendJson(response, 200, { member }, { "cache-control": "no-store" });
      return;
    }
    if (method === "DELETE" && parts.length === 4) {
      service.removePackageMember(actor.user, packageId, parts[3]!);
      sendJson(response, 200, { packageId, userId: parts[3], status: "removed" }, { "cache-control": "no-store" });
      return;
    }
  }

  if (parts[0] === "packages" && parts[1] && parts[2] === "proposals") {
    const actor = authenticateUser(options, bearer(request));
    const packageId = parts[1];
    if (method === "GET" && parts.length === 3) {
      requirePackageManager(options, actor.user, packageId);
      sendJson(response, 200, service.listContributionProposals(packageId), { "cache-control": "no-store" });
      return;
    }
    if (method === "POST" && parts.length === 3) {
      sendJson(response, 202, { proposal: await service.createContributionProposal(actor.user, packageId, await readJson(request)) }, { "cache-control": "no-store" });
      return;
    }
  }

  if (parts[0] === "proposals" && parts[1]) {
    const actor = authenticateUser(options, bearer(request));
    const proposalId = parts[1];
    if (method === "GET" && parts.length === 2) {
      sendJson(response, 200, { proposal: findProposal(options, actor.user, proposalId) }, { "cache-control": "no-store" });
      return;
    }
    if (method === "PATCH" && parts.length === 2) {
      sendJson(response, 200, { proposal: await service.updateContributionProposal(actor.user.userId, proposalId, await readJson(request)) }, { "cache-control": "no-store" });
      return;
    }
    if (method === "POST" && parts.length === 3 && parts[2] === "accept") {
      const input = asObject(await readJson(request));
      sendJson(response, 200, { proposal: service.acceptContributionProposal(actor.user, proposalId, input.expectedRevision as number) }, { "cache-control": "no-store" });
      return;
    }
    if (method === "POST" && parts.length === 3 && parts[2] === "request-changes") {
      sendJson(response, 200, { proposal: service.requestContributionProposalChanges(actor.user, proposalId, await readJson(request)) }, { "cache-control": "no-store" });
      return;
    }
    if (method === "POST" && parts.length === 3 && parts[2] === "reject") {
      sendJson(response, 200, { proposal: service.rejectContributionProposal(actor.user, proposalId, await readJson(request)) }, { "cache-control": "no-store" });
      return;
    }
    if (method === "POST" && parts.length === 3 && parts[2] === "withdraw") {
      await service.withdrawContributionProposal(actor.user.userId, proposalId);
      sendJson(response, 200, { proposalId, status: "withdrawn" }, { "cache-control": "no-store" });
      return;
    }
  }

  if (parts[0] === "admin") {
    const admin = authenticateAdminActor(options, bearer(request));
    if (method === "PATCH" && parts[1] === "users" && parts[2] && parts[3] === "role") {
      const body = asObject(await readJson(request));
      sendJson(response, 200, { user: options.authService.updateUserRole(admin, parts[2]!, requireGlobalRole(body.role)) }, { "cache-control": "no-store" });
      return;
    }
    if (method === "POST" && parts[1] === "submissions" && parts[2] && parts[3] === "approve") {
      const body = await readJson(request);
      const notes = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).notes === "string"
        ? (body as Record<string, string>).notes! : null;
      sendJson(response, 201, await service.approveSubmission(parts[2]!, notes, adminActorId(admin)), { "cache-control": "no-store" });
      return;
    }
    if (method === "POST" && parts[1] === "submissions" && parts[2] && parts[3] === "reject") {
      const body = await readJson(request);
      service.rejectSubmission(parts[2]!, requireText(body, "reason"), adminActorId(admin));
      sendJson(response, 200, { submissionId: parts[2], status: "rejected" }, { "cache-control": "no-store" });
      return;
    }
    if (method === "POST" && parts[1] === "releases" && parts[2] && parts[3] === "revoke") {
      const body = await readJson(request);
      service.revokeRelease(parts[2]!, requireText(body, "reason"), adminActorId(admin));
      sendJson(response, 200, { releaseId: parts[2], status: "revoked" }, { "cache-control": "no-store" });
      return;
    }
  }

  throw new HubError(404, "route_not_found", "The requested Hub route does not exist");
}

function authenticateUser(options: HubServerOptions, token: string | null): AuthenticatedUser {
  if (!token) throw new HubError(401, "hub_auth_required", "Hub bearer token is required");
  return options.authService.authenticate(token);
}

function authenticatePublisher(options: HubServerOptions, token: string | null): PublisherIdentity {
  if (!token) throw new HubError(401, "publisher_auth_required", "Publisher bearer token is required");
  for (const credential of options.publisherCredentials.values()) {
    if (credential.token === token) return credential;
  }
  if (!token.startsWith("wph_")) throw new HubError(403, "publisher_auth_invalid", "Publisher bearer token is invalid");
  const user = authenticateUser(options, token).user;
  return { id: user.userId, name: user.name, profileUrl: user.profileUrl };
}

function authenticateAdminActor(options: HubServerOptions, token: string | null): HubActor {
  if (!token) throw new HubError(401, "admin_auth_required", "Administrator bearer token is required");
  if (options.adminToken && token === options.adminToken) {
    return { kind: "admin", id: "admin", name: "WuxianPi Hub 管理员" };
  }
  if (options.adminToken && !token.startsWith("wph_")) {
    throw new HubError(403, "admin_auth_invalid", "Administrator bearer token is invalid");
  }
  const user = authenticateUser(options, token);
  if (user.user.role !== "admin") throw new HubError(403, "admin_required", "Administrator access is required");
  return user;
}

function adminActorId(actor: HubActor): string {
  return actor.kind === "user" ? actor.user.userId : actor.id;
}

function requireReviewer(user: AuthenticatedUser): void {
  if (user.user.role !== "reviewer" && user.user.role !== "admin") {
    throw new HubError(403, "reviewer_required", "Reviewer or administrator access is required");
  }
}

function requirePackageManager(options: HubServerOptions, user: HubUser, packageId: string): void {
  if (user.role === "admin") return;
  const member = options.database.getPackageMember(packageId, user.userId);
  if (member?.role === "owner" || member?.role === "maintainer") return;
  throw new HubError(403, "package_maintainer_required", "Package owner or maintainer access is required");
}

function findProposal(options: HubServerOptions, user: HubUser, proposalId: string): Record<string, unknown> {
  const own = options.service.listContributorProposals(user.userId).proposals.find((item) => item.proposalId === proposalId);
  if (own) return own as unknown as Record<string, unknown>;
  const stored = options.database.getContributionProposal(proposalId);
  const member = stored ? options.database.getPackageMember(stored.packageId, user.userId) : null;
  if (stored && (user.role === "admin" || member?.role === "owner" || member?.role === "maintainer")) {
    const proposal = options.service.listContributionProposals(stored.packageId).proposals.find((item) => item.proposalId === proposalId);
    if (proposal) return proposal as unknown as Record<string, unknown>;
  }
  throw new HubError(404, "proposal_not_found", "The requested contribution proposal does not exist");
}

function assertSubmissionRevision(service: HubService, submissionId: string, body: unknown): void {
  const input = asObject(body);
  if (input.expectedRevision === undefined) return;
  if (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new HubError(400, "invalid_revision", "expectedRevision must be a positive integer");
  }
  const current = service.getSubmissionGovernance(submissionId).revision;
  if (current !== input.expectedRevision) {
    throw new HubError(409, "submission_revision_stale", "The submission changed after the reviewer loaded it");
  }
}

function authenticateIssueActor(options: HubServerOptions, token: string | null): IssueActor {
  if (!token) return { kind: "anonymous" };
  if (options.adminToken && token === options.adminToken) return { kind: "admin", id: "admin", name: "WuxianPi Hub 管理员" };
  for (const publisher of options.publisherCredentials.values()) {
    if (publisher.token === token) return { kind: "publisher", id: publisher.id, name: publisher.name };
  }
  if (token.startsWith("wph_")) {
    const user = authenticateUser(options, token).user;
    return { kind: "publisher", id: user.userId, name: user.name };
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
