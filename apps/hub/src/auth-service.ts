import { createHash, randomBytes } from "node:crypto";
import { HubError } from "./errors.js";
import type { GitHubAuthGateway, GitHubDeviceAuthorization, GitHubIdentity } from "./github-auth.js";
import type {
  AuthenticatedUser,
  GlobalRole,
  HubActor,
  HubMeResponse,
  HubSession,
  HubSessionCredential,
  HubUser,
  SessionKind,
} from "./types.js";

export interface StoredHubSession extends HubSession {
  tokenHash: string;
}

export interface HubAuthDatabase {
  upsertUser(identity: Pick<HubUser, "githubId" | "login" | "name" | "avatarUrl" | "profileUrl">, now: string): HubUser;
  getUser(userId: string): HubUser | null;
  updateUserRole(userId: string, role: GlobalRole, now: string): boolean;
  insertSession(session: StoredHubSession): void;
  getSessionByTokenHash(tokenHash: string): HubSession | null;
  touchSession(sessionId: string, lastUsedAt: string): boolean;
  listSessions(userId: string): HubSession[];
  revokeSession(sessionId: string, revokedAt: string, userId?: string): boolean;
}

export interface HubAuthServiceOptions {
  database: HubAuthDatabase;
  github: GitHubAuthGateway;
  githubClientId: string;
  sessionDays: number;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
}

export interface SessionRequest {
  kind: SessionKind;
  label?: string;
}

const HUB_TOKEN_PATTERN = /^wph_[A-Za-z0-9_-]{43}$/;
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const MAX_GITHUB_TOKEN_LENGTH = 512;
const MAX_SESSION_LABEL_LENGTH = 120;

export class HubAuthService {
  private readonly now: () => Date;
  private readonly random: (size: number) => Buffer;

  constructor(private readonly options: HubAuthServiceOptions) {
    if (!Number.isInteger(options.sessionDays) || options.sessionDays < 1 || options.sessionDays > 365) {
      throw new Error("sessionDays must be an integer between 1 and 365");
    }
    this.now = options.now ?? (() => new Date());
    this.random = options.randomBytes ?? randomBytes;
  }

  async exchangeGitHubToken(githubToken: string, request: SessionRequest = { kind: "browser" }): Promise<HubSessionCredential> {
    const token = requireGitHubToken(githubToken);
    const identity = await this.options.github.getIdentity(token);
    return this.issueSession(identity, request);
  }

  async startGitHubDeviceFlow(): Promise<GitHubDeviceAuthorization> {
    return await this.options.github.startDeviceFlow(this.requireGitHubClientId());
  }

  async completeGitHubDeviceFlow(deviceCode: string, request: SessionRequest = { kind: "device" }): Promise<HubSessionCredential> {
    const code = requireDeviceCode(deviceCode);
    const identity = await this.options.github.completeDeviceFlow(this.requireGitHubClientId(), code);
    return this.issueSession(identity, request);
  }

  authenticate(hubToken: string): AuthenticatedUser {
    const { session, user } = this.resolveSession(hubToken, true);
    return { kind: "user", user, sessionId: session.sessionId };
  }

  getMe(hubToken: string): HubMeResponse {
    const { session, user } = this.resolveSession(hubToken, true);
    return { user, session };
  }

  listSessions(hubToken: string): HubSession[] {
    const { user } = this.resolveSession(hubToken, true);
    return this.options.database.listSessions(user.userId);
  }

  logout(hubToken: string): void {
    const { session, user } = this.resolveSession(hubToken, false);
    const revoked = this.options.database.revokeSession(session.sessionId, this.nowIso(), user.userId);
    if (!revoked) throw new HubError(401, "hub_auth_invalid", "Hub session is no longer active");
  }

  revokeOwnSession(hubToken: string, sessionId: string): void {
    const { user } = this.resolveSession(hubToken, true);
    if (!isSessionId(sessionId)) throw new HubError(400, "invalid_session", "sessionId is invalid");
    const revoked = this.options.database.revokeSession(sessionId, this.nowIso(), user.userId);
    if (!revoked) throw new HubError(404, "session_not_found", "The requested session does not exist");
  }

  updateUserRole(actor: HubActor, userId: string, role: GlobalRole): HubUser {
    if (!isAdmin(actor)) throw new HubError(403, "admin_required", "Administrator access is required");
    if (!isUserId(userId)) throw new HubError(400, "invalid_user", "userId is invalid");
    if (!isGlobalRole(role)) throw new HubError(400, "invalid_role", "role is invalid");
    if (!this.options.database.updateUserRole(userId, role, this.nowIso())) {
      throw new HubError(404, "user_not_found", "The requested user does not exist");
    }
    const user = this.options.database.getUser(userId);
    if (!user) throw new HubError(500, "user_missing", "Updated Hub user could not be reloaded");
    return user;
  }

  private issueSession(identity: GitHubIdentity, request: SessionRequest): HubSessionCredential {
    validateIdentity(identity);
    const kind = requireSessionKind(request.kind);
    const label = normalizeSessionLabel(request.label, kind);
    const now = this.now();
    const nowIso = now.toISOString();
    const user = this.options.database.upsertUser(identity, nowIso);
    const token = `wph_${this.random(32).toString("base64url")}`;
    if (!HUB_TOKEN_PATTERN.test(token)) throw new Error("Hub token generator returned invalid entropy");
    const session: StoredHubSession = {
      sessionId: `ses_${this.random(18).toString("base64url")}`,
      userId: user.userId,
      kind,
      label,
      tokenHash: hashToken(token),
      createdAt: nowIso,
      lastUsedAt: nowIso,
      expiresAt: new Date(now.getTime() + this.options.sessionDays * 86_400_000).toISOString(),
      revokedAt: null,
    };
    this.options.database.insertSession(session);
    const { tokenHash: _tokenHash, ...publicSession } = session;
    return { token, user, session: publicSession };
  }

  private resolveSession(hubToken: string, touch: boolean): { session: HubSession; user: HubUser } {
    const token = requireHubToken(hubToken);
    const session = this.options.database.getSessionByTokenHash(hashToken(token));
    if (!session || session.revokedAt) throw new HubError(401, "hub_auth_invalid", "Hub session is invalid or revoked");
    const now = this.now();
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new HubError(401, "hub_auth_invalid", "Hub session has invalid expiry metadata");
    }
    if (expiresAt <= now.getTime()) {
      this.options.database.revokeSession(session.sessionId, now.toISOString(), session.userId);
      throw new HubError(401, "hub_session_expired", "Hub session has expired");
    }
    const user = this.options.database.getUser(session.userId);
    if (!user) throw new HubError(401, "hub_auth_invalid", "Hub session user no longer exists");
    if (touch) {
      const lastUsedAt = now.toISOString();
      if (!this.options.database.touchSession(session.sessionId, lastUsedAt)) {
        throw new HubError(401, "hub_auth_invalid", "Hub session is invalid or revoked");
      }
      return { session: { ...session, lastUsedAt }, user };
    }
    return { session, user };
  }

  private requireGitHubClientId(): string {
    const clientId = this.options.githubClientId.trim();
    if (!clientId) throw new HubError(503, "github_device_auth_not_configured", "GitHub device authorization is not configured");
    return clientId;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function requireGitHubToken(value: string): string {
  if (typeof value !== "string") throw new HubError(400, "github_token_required", "A GitHub token is required");
  const token = value.trim();
  if (!token || token.length > MAX_GITHUB_TOKEN_LENGTH || /\s/.test(token)) {
    throw new HubError(400, "github_token_invalid", "GitHub token is invalid");
  }
  return token;
}

function requireHubToken(value: string): string {
  if (typeof value !== "string" || !HUB_TOKEN_PATTERN.test(value)) {
    throw new HubError(401, "hub_auth_invalid", "Hub bearer token is invalid");
  }
  return value;
}

function requireDeviceCode(value: string): string {
  if (typeof value !== "string") throw new HubError(400, "github_device_code_required", "deviceCode is required");
  const code = value.trim();
  if (!DEVICE_CODE_PATTERN.test(code)) throw new HubError(400, "github_device_code_invalid", "deviceCode is invalid");
  return code;
}

function requireSessionKind(value: SessionKind): SessionKind {
  if (value !== "browser" && value !== "device") throw new HubError(400, "invalid_session_kind", "kind must be browser or device");
  return value;
}

function normalizeSessionLabel(value: string | undefined, kind: SessionKind): string {
  if (value === undefined) return kind === "browser" ? "Web browser" : "WuxianPi device";
  const label = value.trim();
  if (!label || label.length > MAX_SESSION_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new HubError(400, "invalid_session_label", `label must be between 1 and ${MAX_SESSION_LABEL_LENGTH} printable characters`);
  }
  return label;
}

function validateIdentity(identity: GitHubIdentity): void {
  if (!/^[1-9]\d*$/.test(identity.githubId) || !identity.login.trim() || !identity.profileUrl.startsWith("https://")) {
    throw new HubError(502, "github_identity_invalid", "GitHub returned an invalid user identity");
  }
}

function isSessionId(value: string): boolean {
  return typeof value === "string" && /^ses_[A-Za-z0-9_-]{24}$/.test(value);
}

function isUserId(value: string): boolean {
  return typeof value === "string" && value.length >= 3 && value.length <= 160 && /^[A-Za-z0-9:_-]+$/.test(value);
}

function isGlobalRole(value: string): value is GlobalRole {
  return value === "user" || value === "reviewer" || value === "admin";
}

function isAdmin(actor: HubActor): boolean {
  return actor.kind === "admin" || (actor.kind === "user" && actor.user.role === "admin");
}
