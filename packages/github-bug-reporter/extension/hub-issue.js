const DEFAULT_HUB_URL = "https://wuxianpihub.webefficacy.com";

export class HubIssueClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.WUXIANPI_HUB_URL || DEFAULT_HUB_URL).replace(/\/+$/, "");
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = options.timeoutMs || 60_000;
  }

  async search(input, token, signal) {
    const query = new URLSearchParams({ q: input.title, limit: "5" });
    if (input.packageId) query.set("packageId", input.packageId);
    const body = await this.request(`/api/v1/issues?${query}`, { token, signal });
    return Array.isArray(body.issues) ? body.issues : [];
  }

  async create(input, token, signal) {
    return await this.request("/api/v1/issues", {
      method: "POST",
      token,
      signal,
      body: {
        packageId: input.packageId || undefined,
        component: input.component || undefined,
        targetRepository: input.repository || undefined,
        reporterName: input.reporterName || "WuxianPi 用户",
        title: input.title,
        body: input.body,
        labels: input.labels,
        environment: input.environment,
        visibility: input.visibility,
        source: "assistant",
        userConfirmed: true,
      },
    });
  }

  async get(issueId, token, signal) {
    return await this.request(`/api/v1/issues/${encodeURIComponent(issueId)}`, { token, signal });
  }

  async comment(issueId, body, token, signal) {
    return await this.request(`/api/v1/issues/${encodeURIComponent(issueId)}/comments`, {
      method: "POST", token, signal, body: { body },
    });
  }

  async request(path, options = {}) {
    if (typeof this.fetch !== "function") throw new Error("当前 Node.js 环境不支持 fetch");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: options.method || "GET",
        headers: {
          accept: "application/json",
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal,
      });
    } catch (error) {
      throw new Error(`无法连接 WuxianPi Hub：${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `WuxianPi Hub 返回 HTTP ${response.status}`);
    return body;
  }
}
