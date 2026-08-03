import { HubError } from "./errors.js";

export interface GitHubIdentity {
  githubId: string;
  login: string;
  name: string;
  avatarUrl: string | null;
  profileUrl: string;
}

export interface GitHubDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GitHubAuthGateway {
  getIdentity(token: string): Promise<GitHubIdentity>;
  startDeviceFlow(clientId: string): Promise<GitHubDeviceAuthorization>;
  completeDeviceFlow(clientId: string, deviceCode: string): Promise<GitHubIdentity>;
}

export class RealGitHubAuthGateway implements GitHubAuthGateway {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getIdentity(token: string): Promise<GitHubIdentity> {
    const response = await this.fetchImpl("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "WuxianPi-Hub",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new HubError(401, "github_auth_invalid", "GitHub did not accept this credential");
    const payload = await parsePayload(response);
    const githubId = normalizeGitHubId(payload.id);
    if (!githubId || typeof payload.login !== "string" || !payload.login.trim()) {
      throw new HubError(502, "github_identity_invalid", "GitHub returned an invalid user identity");
    }
    const login = payload.login.trim();
    return {
      githubId,
      login,
      name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : login,
      avatarUrl: typeof payload.avatar_url === "string" ? payload.avatar_url : null,
      profileUrl: typeof payload.html_url === "string" ? payload.html_url : `https://github.com/${encodeURIComponent(login)}`,
    };
  }

  async startDeviceFlow(clientId: string): Promise<GitHubDeviceAuthorization> {
    const payload = await this.deviceRequest("https://github.com/login/device/code", { client_id: clientId, scope: "read:user" });
    if (typeof payload.device_code !== "string" || typeof payload.user_code !== "string" || typeof payload.verification_uri !== "string") {
      throw new HubError(502, "github_device_flow_invalid", "GitHub returned an invalid device authorization");
    }
    return {
      deviceCode: payload.device_code,
      userCode: payload.user_code,
      verificationUri: payload.verification_uri,
      expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : 900,
      interval: typeof payload.interval === "number" ? payload.interval : 5,
    };
  }

  async completeDeviceFlow(clientId: string, deviceCode: string): Promise<GitHubIdentity> {
    const payload = await this.deviceRequest("https://github.com/login/oauth/access_token", {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (typeof payload.error === "string") {
      const status = payload.error === "authorization_pending" || payload.error === "slow_down" ? 409 : 401;
      throw new HubError(status, `github_${payload.error}`, typeof payload.error_description === "string" ? payload.error_description : payload.error);
    }
    if (typeof payload.access_token !== "string") throw new HubError(502, "github_token_missing", "GitHub did not return an access token");
    return await this.getIdentity(payload.access_token);
  }

  private async deviceRequest(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "WuxianPi-Hub" },
      body: new URLSearchParams(body),
    });
    if (!response.ok) throw new HubError(502, "github_unavailable", `GitHub authorization failed (${response.status})`);
    return await parsePayload(response);
  }
}

function normalizeGitHubId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  return value;
}

async function parsePayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = await response.json();
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
  } catch {
    // Converted into a stable upstream error below.
  }
  throw new HubError(502, "github_response_invalid", "GitHub returned an invalid authorization response");
}
