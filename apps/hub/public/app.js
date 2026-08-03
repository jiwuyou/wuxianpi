const state = {
  q: "",
  category: "",
  contributionType: "",
  nextCursor: null,
  packages: [],
  selectedId: null,
  selectedPackage: null,
  issues: [],
  issuePackageId: null,
  selectedIssueNumber: null,
  // Hub bearer credentials are intentionally memory-only. A page reload requires an explicit login.
  sessionToken: "",
  identity: null,
  deviceAuthorization: null,
  managementTab: "submissions",
};

const elements = {
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  contributionSelect: document.querySelector("#contributionSelect"),
  categoryTabs: document.querySelector("#categoryTabs"),
  packageList: document.querySelector("#packageList"),
  resultCount: document.querySelector("#resultCount"),
  statusBanner: document.querySelector("#statusBanner"),
  loadMoreButton: document.querySelector("#loadMoreButton"),
  refreshButton: document.querySelector("#refreshButton"),
  detailPanel: document.querySelector("#detailPanel"),
  detailEmpty: document.querySelector("#detailEmpty"),
  detailContent: document.querySelector("#detailContent"),
  closeDetailButton: document.querySelector("#closeDetailButton"),
  issuesButton: document.querySelector("#issuesButton"),
  detailIssuesButton: document.querySelector("#detailIssuesButton"),
  packageIssueList: document.querySelector("#packageIssueList"),
  issuesDialog: document.querySelector("#issuesDialog"),
  issueSearchInput: document.querySelector("#issueSearchInput"),
  issueStatusFilter: document.querySelector("#issueStatusFilter"),
  issueList: document.querySelector("#issueList"),
  issueDetail: document.querySelector("#issueDetail"),
  createIssueButton: document.querySelector("#createIssueButton"),
  createIssueDialog: document.querySelector("#createIssueDialog"),
  createIssueForm: document.querySelector("#createIssueForm"),
  createIssueStatus: document.querySelector("#createIssueStatus"),
  publishButton: document.querySelector("#publishButton"),
  publishDialog: document.querySelector("#publishDialog"),
  publishForm: document.querySelector("#publishForm"),
  publishStatus: document.querySelector("#publishStatus"),
  accountButton: document.querySelector("#accountButton"),
  accountAvatar: document.querySelector("#accountAvatar"),
  accountLabel: document.querySelector("#accountLabel"),
  accountDialog: document.querySelector("#accountDialog"),
  signedOutPanel: document.querySelector("#signedOutPanel"),
  signedInPanel: document.querySelector("#signedInPanel"),
  tokenLoginForm: document.querySelector("#tokenLoginForm"),
  deviceLoginButton: document.querySelector("#deviceLoginButton"),
  deviceCodePanel: document.querySelector("#deviceCodePanel"),
  deviceVerificationLink: document.querySelector("#deviceVerificationLink"),
  deviceUserCode: document.querySelector("#deviceUserCode"),
  deviceCompleteButton: document.querySelector("#deviceCompleteButton"),
  authStatus: document.querySelector("#authStatus"),
  identityAvatar: document.querySelector("#identityAvatar"),
  identityName: document.querySelector("#identityName"),
  identityProfile: document.querySelector("#identityProfile"),
  identityRole: document.querySelector("#identityRole"),
  openManagementButton: document.querySelector("#openManagementButton"),
  logoutButton: document.querySelector("#logoutButton"),
  manageButton: document.querySelector("#manageButton"),
  managementDialog: document.querySelector("#managementDialog"),
  managementTabs: document.querySelector("#managementTabs"),
  managementPackageId: document.querySelector("#managementPackageId"),
  managementRefreshButton: document.querySelector("#managementRefreshButton"),
  managementContent: document.querySelector("#managementContent"),
};

const categoryLabels = {
  app: "应用",
  assistant: "助手",
  capability: "能力",
  skill: "Skill",
  interface: "界面",
  "knowledge-experience": "知识与经验",
  solution: "解决方案",
};

const issueStatusLabels = {
  pending: "待确认",
  confirmed: "已确认",
  in_progress: "修复中",
  awaiting_verification: "待验证",
  resolved: "已解决",
  cannot_reproduce: "无法复现",
  declined: "不处理",
  migrated: "已迁移",
};

const submissionStatusLabels = {
  queued: "排队中",
  verifying: "核验中",
  awaiting_review: "等待审核",
  changes_requested: "需要修改",
  approved: "已批准",
  rejected: "已拒绝",
  failed: "核验失败",
  withdrawn: "已撤回",
};

const proposalStatusLabels = {
  queued: "排队中",
  verifying: "核验中",
  awaiting_owner: "等待维护者",
  changes_requested: "需要修改",
  accepted: "已接受，等待市场审核",
  rejected: "已拒绝",
  failed: "核验失败",
  withdrawn: "已撤回",
  released: "已发布",
};

const reviewReasonLabels = {
  security: "安全与权限",
  integrity: "来源或完整性",
  manifest: "Manifest",
  quality: "实现质量",
  compatibility: "兼容性",
  documentation: "说明不足",
  policy: "市场规范",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body.error?.code;
    throw error;
  }
  return body;
}

function authenticatedApi(path, options = {}) {
  if (!state.sessionToken) return Promise.reject(new Error("请先登录 Hub 账户"));
  return api(path, {
    ...options,
    headers: { authorization: `Bearer ${state.sessionToken}`, ...(options.headers || {}) },
  }).catch((error) => {
    if (error.status === 401) clearSession("Hub 会话已失效，请重新登录");
    if (error.status === 404) error.message = "当前 Hub 服务版本尚未提供此管理功能";
    throw error;
  });
}

function rows(body, key) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.[key])) return body[key];
  if (Array.isArray(body?.data?.[key])) return body.data[key];
  return [];
}

function firstValue(body, keys) {
  for (const key of keys) {
    if (body?.[key] !== undefined) return body[key];
    if (body?.data?.[key] !== undefined) return body.data[key];
  }
  return null;
}

function reporterToken() {
  const key = "wuxianpiHubReporterToken";
  let token = localStorage.getItem(key);
  if (!token) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    token = `wuxianpi_reporter_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
    localStorage.setItem(key, token);
  }
  return token;
}

function issueApi(path, options = {}) {
  return api(path, {
    ...options,
    headers: { authorization: `Bearer ${reporterToken()}`, ...(options.headers || {}) },
  });
}

function setStatus(message = "") {
  elements.statusBanner.textContent = message;
  elements.statusBanner.classList.toggle("hidden", !message);
}

function packageCard(item) {
  const selected = item.id === state.selectedId ? " selected" : "";
  const categories = item.categories.map((category) => `<span class="chip">${escapeHtml(categoryLabels[category] || category)}</span>`).join("");
  return `<article class="package-card${selected}" data-package-id="${escapeHtml(item.id)}" tabindex="0">
    <div class="card-top">
      <div><h2>${escapeHtml(item.name)}</h2><p class="package-id">${escapeHtml(item.id)}</p></div>
      <span class="version">Release</span>
    </div>
    <p class="card-summary">${escapeHtml(item.summary)}</p>
    <div class="chip-row">${categories}</div>
  </article>`;
}

function renderPackages() {
  elements.resultCount.textContent = `${state.packages.length} 个 Package`;
  elements.packageList.innerHTML = state.packages.length
    ? state.packages.map(packageCard).join("")
    : '<div class="empty-list">没有匹配的 Package</div>';
  elements.loadMoreButton.classList.toggle("hidden", !state.nextCursor);
}

async function loadPackages({ append = false } = {}) {
  setStatus();
  if (!append) {
    elements.resultCount.textContent = "正在加载";
    elements.packageList.innerHTML = '<div class="empty-list">正在读取目录</div>';
  }
  const query = new URLSearchParams({ limit: "24" });
  if (state.q) query.set("q", state.q);
  if (state.category) query.set("category", state.category);
  if (state.contributionType) query.set("contributionType", state.contributionType);
  if (append && state.nextCursor) query.set("cursor", state.nextCursor);
  try {
    const body = await api(`/api/v1/packages?${query}`);
    state.packages = append ? [...state.packages, ...body.packages] : body.packages;
    state.nextCursor = body.nextCursor;
    renderPackages();
  } catch (error) {
    setStatus(error.message);
    if (!append) {
      state.packages = [];
      renderPackages();
    }
  }
}

async function showPackage(packageId) {
  state.selectedId = packageId;
  renderPackages();
  elements.detailEmpty.classList.add("hidden");
  elements.detailContent.classList.remove("hidden");
  elements.detailPanel.classList.add("open");
  try {
    const [detailBody, releasesBody] = await Promise.all([
      api(`/api/v1/packages/${encodeURIComponent(packageId)}`),
      api(`/api/v1/packages/${encodeURIComponent(packageId)}/releases?limit=10`),
    ]);
    const item = detailBody.package;
    state.selectedPackage = item;
    document.querySelector("#detailId").textContent = item.id;
    document.querySelector("#detailTitle").textContent = item.name;
    document.querySelector("#detailSummary").textContent = item.description || item.summary;
    document.querySelector("#detailCategories").innerHTML = item.categories.map((category) => `<span class="chip">${escapeHtml(categoryLabels[category] || category)}</span>`).join("");
    document.querySelector("#detailFacts").innerHTML = `
      <dt>发布者</dt><dd>${escapeHtml(item.publisher.name)}</dd>
      <dt>版本</dt><dd>${escapeHtml(item.latestRelease.version)}</dd>
      <dt>许可证</dt><dd>${escapeHtml(item.license || "未声明")}</dd>
      <dt>Commit</dt><dd title="${escapeHtml(item.latestRelease.approvedCommit)}">${escapeHtml(item.latestRelease.approvedCommit.slice(0, 12))}</dd>`;
    const plan = document.querySelector("#installPlanLink");
    plan.href = `/api/v1/packages/${encodeURIComponent(item.id)}/install-plan?releaseId=${encodeURIComponent(item.latestRelease.releaseId)}`;
    const source = item.links.find((link) => link.kind === "source") || item.links[0];
    const sourceLink = document.querySelector("#sourceLink");
    sourceLink.href = source?.url || "#";
    sourceLink.classList.toggle("hidden", !source);
    document.querySelector("#contributionList").innerHTML = item.contributionTypes.map((type) => `<span class="contribution-item">${escapeHtml(type)}</span>`).join("");
    document.querySelector("#releaseList").innerHTML = releasesBody.releases.map((release) => `<div class="release-item">
      <div><strong>${escapeHtml(release.version)}</strong><p>${escapeHtml(release.approvedCommit)}</p></div>
      <time>${new Date(release.publishedAt).toLocaleDateString()}</time>
    </div>`).join("");
    const screenshotSection = document.querySelector("#screenshotSection");
    const screenshotList = document.querySelector("#screenshotList");
    screenshotSection.classList.toggle("hidden", item.screenshots.length === 0);
    screenshotList.innerHTML = item.screenshots.map((screenshot) => {
      const image = [...screenshot.downloadSources].sort((a, b) => b.priority - a.priority)[0];
      return image ? `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(screenshot.alt)}" width="${screenshot.width}" height="${screenshot.height}" loading="lazy">` : "";
    }).join("");
    await loadPackageIssues(item.id);
  } catch (error) {
    setStatus(error.message);
    closeDetail();
  }
}

async function loadPackageIssues(packageId) {
  elements.packageIssueList.innerHTML = '<p class="issue-empty">正在读取问题</p>';
  try {
    const body = await issueApi(`/api/v1/issues?packageId=${encodeURIComponent(packageId)}&limit=5`);
    elements.packageIssueList.innerHTML = body.issues.length ? body.issues.map((issue) => `
      <button class="compact-issue" type="button" data-issue-number="${issue.issueNumber}">
        <span class="issue-number">#${issue.issueNumber}</span>
        <strong>${escapeHtml(issue.title)}</strong>
      </button>`).join("") : '<p class="issue-empty">暂时没有公开问题</p>';
  } catch (error) {
    elements.packageIssueList.innerHTML = `<p class="issue-empty">${escapeHtml(error.message)}</p>`;
  }
}

async function openIssues(packageId = null, issueNumber = null) {
  state.issuePackageId = packageId;
  elements.issueSearchInput.value = "";
  elements.issueStatusFilter.value = "";
  if (!elements.issuesDialog.open) elements.issuesDialog.showModal();
  await loadIssues();
  if (issueNumber) await showIssue(issueNumber, false);
}

async function loadIssues() {
  const query = new URLSearchParams({ limit: "100" });
  const q = elements.issueSearchInput.value.trim();
  if (q) query.set("q", q);
  if (state.issuePackageId) query.set("packageId", state.issuePackageId);
  if (elements.issueStatusFilter.value) query.set("status", elements.issueStatusFilter.value);
  elements.issueList.innerHTML = '<p class="issue-empty">正在读取问题</p>';
  try {
    const body = await issueApi(`/api/v1/issues?${query}`);
    state.issues = body.issues;
    renderIssues();
  } catch (error) {
    state.issues = [];
    elements.issueList.innerHTML = `<p class="issue-empty">${escapeHtml(error.message)}</p>`;
  }
}

function renderIssues() {
  elements.issueList.innerHTML = state.issues.length ? state.issues.map((issue) => `
    <button class="issue-list-item${issue.issueNumber === state.selectedIssueNumber ? " active" : ""}" type="button" data-issue-number="${issue.issueNumber}">
      <span class="issue-list-meta"><span>#${issue.issueNumber}${issue.packageId ? ` · ${escapeHtml(issue.packageId)}` : ""}</span><span class="issue-status">${escapeHtml(issueStatusLabels[issue.status] || issue.status)}</span></span>
      <strong>${escapeHtml(issue.title)}</strong>
    </button>`).join("") : '<p class="issue-empty">没有匹配的问题</p>';
}

async function showIssue(issueNumber, updateHistory = true) {
  state.selectedIssueNumber = Number(issueNumber);
  renderIssues();
  elements.issueDetail.classList.add("open");
  elements.issueDetail.innerHTML = '<p class="issue-placeholder">正在读取问题</p>';
  try {
    const body = await issueApi(`/api/v1/issues/${encodeURIComponent(issueNumber)}`);
    const issue = body.issue;
    const comments = body.comments || [];
    elements.issueDetail.innerHTML = `
      <div class="issue-detail-header">
        <div><span class="issue-number">#${issue.issueNumber}</span><h2>${escapeHtml(issue.title)}</h2></div>
        <span class="issue-status">${escapeHtml(issueStatusLabels[issue.status] || issue.status)}</span>
      </div>
      <p class="issue-meta">${escapeHtml(issue.packageId || "WuxianPi 核心")} · ${escapeHtml(issue.component || "未指定组件")} · ${escapeHtml(issue.reporterName)} · ${new Date(issue.createdAt).toLocaleString()}</p>
      ${issue.githubUrl ? `<p><a class="command-button" href="${escapeHtml(issue.githubUrl)}" target="_blank" rel="noreferrer">打开 GitHub Issue</a></p>` : ""}
      <pre class="issue-body">${escapeHtml(issue.body)}</pre>
      <section class="issue-comments"><h3>评论</h3>${comments.length ? comments.map((comment) => `
        <div class="issue-comment"><span class="issue-comment-meta">${escapeHtml(comment.actorName)} · ${new Date(comment.createdAt).toLocaleString()}</span><p>${escapeHtml(comment.body)}</p></div>`).join("") : '<p class="issue-empty">还没有评论</p>'}</section>
      <form class="issue-action-form" data-action="comment" data-issue-number="${issue.issueNumber}">
        <textarea name="body" required maxlength="12000" placeholder="补充复现信息或处理进展"></textarea>
        <div class="issue-action-row"><span class="form-status" role="status"></span><button class="command-button" type="submit">发表评论</button></div>
      </form>
      ${issue.status === "awaiting_verification" ? `<div class="issue-action-form"><h3>验证修复</h3><div class="issue-action-row"><button class="command-button" type="button" data-verify="false" data-issue-number="${issue.issueNumber}">仍有问题</button><button class="command-button primary" type="button" data-verify="true" data-issue-number="${issue.issueNumber}">确认已修复</button></div></div>` : ""}
      <form class="issue-action-form" data-action="maintain" data-issue-number="${issue.issueNumber}">
        <h3>维护者操作</h3>
        ${state.identity ? '<p class="form-note">使用当前 Hub 账户执行维护者操作。</p>' : '<input name="token" type="password" required placeholder="Publisher 或管理员 Token" autocomplete="current-password">'}
        <select name="status">
          ${Object.entries(issueStatusLabels).map(([value, label]) => `<option value="${value}"${value === issue.status ? " selected" : ""}>${label}</option>`).join("")}
        </select>
        <input name="githubUrl" type="url" value="${escapeHtml(issue.githubUrl || "")}" placeholder="手动迁移后的 GitHub Issue URL">
        <div class="issue-action-row"><span class="form-status" role="status"></span><button class="command-button" type="submit">保存状态</button></div>
      </form>`;
    if (updateHistory) history.pushState({ issueNumber: issue.issueNumber }, "", `/issues/${issue.issueNumber}`);
  } catch (error) {
    elements.issueDetail.innerHTML = `<p class="issue-placeholder">${escapeHtml(error.message)}</p>`;
  }
}

function prepareCreateIssue() {
  const form = elements.createIssueForm;
  form.reset();
  form.elements.packageId.value = state.issuePackageId || state.selectedPackage?.id || "";
  const source = state.selectedPackage?.links?.find((link) => link.kind === "source")?.url || "";
  form.elements.targetRepository.value = source.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  elements.createIssueStatus.textContent = "";
  elements.createIssueDialog.showModal();
}

function setSession(payload) {
  const session = firstValue(payload, ["session"]);
  const token = firstValue(payload, ["sessionToken", "token", "accessToken"])
    || firstValue(session, ["sessionToken", "token", "accessToken"]);
  const identity = firstValue(payload, ["user", "identity", "me"]) || firstValue(session, ["user", "identity"]);
  if (typeof token === "string" && token) {
    state.sessionToken = token;
  }
  if (identity && typeof identity === "object") state.identity = identity;
  renderAccount();
}

function clearSession(message = "") {
  state.sessionToken = "";
  state.identity = null;
  renderAccount();
  if (message) elements.authStatus.textContent = message;
}

function renderAccount() {
  const user = state.identity;
  elements.signedOutPanel.classList.toggle("hidden", Boolean(user));
  elements.signedInPanel.classList.toggle("hidden", !user);
  elements.manageButton.classList.toggle("hidden", !user);
  elements.accountLabel.textContent = user?.login || "登录";
  elements.accountAvatar.textContent = (user?.login || "G").slice(0, 1).toUpperCase();
  if (!user) return;
  elements.identityName.textContent = user.name || user.login;
  elements.identityProfile.textContent = `@${user.login}`;
  elements.identityProfile.href = user.profileUrl || `https://github.com/${encodeURIComponent(user.login)}`;
  elements.identityRole.textContent = user.role === "admin" ? "管理员" : user.role === "reviewer" ? "审核员" : "用户";
  elements.identityAvatar.src = user.avatarUrl || "";
  elements.identityAvatar.classList.toggle("hidden", !user.avatarUrl);
}

async function loadIdentity() {
  if (!state.sessionToken) {
    renderAccount();
    return;
  }
  try {
    const body = await authenticatedApi("/api/v1/me");
    const identity = firstValue(body, ["user", "identity", "me"]);
    if (!identity) throw new Error("Hub 没有返回账户信息");
    state.identity = identity;
  } catch (error) {
    if (error.status !== 401) elements.authStatus.textContent = error.message;
  }
  renderAccount();
}

function openAccount() {
  elements.authStatus.textContent = "";
  renderAccount();
  elements.accountDialog.showModal();
}

function openManagement(tab = "submissions") {
  if (!state.identity) {
    openAccount();
    return;
  }
  state.managementTab = tab;
  if (!elements.managementPackageId.value && state.selectedPackage?.id) elements.managementPackageId.value = state.selectedPackage.id;
  elements.managementTabs.querySelectorAll("[data-management-tab]").forEach((button) => button.classList.toggle("active", button.dataset.managementTab === tab));
  if (!elements.managementDialog.open) elements.managementDialog.showModal();
  void loadManagement();
}

function managementMessage(message, tone = "") {
  elements.managementContent.innerHTML = `<p class="management-message ${escapeHtml(tone)}">${escapeHtml(message)}</p>`;
}

function statusBadge(status, labels) {
  const active = ["approved", "released", "accepted"].includes(status) ? "success"
    : ["rejected", "failed", "withdrawn"].includes(status) ? "error"
      : status === "changes_requested" ? "warning" : "pending";
  return `<span class="status-badge ${active}">${escapeHtml(labels[status] || status)}</span>`;
}

function submissionCard(item, reviewer = false) {
  const diagnostics = Array.isArray(item.diagnostics) ? item.diagnostics : [];
  const reviews = Array.isArray(item.reviews) ? item.reviews : [];
  const mutable = !["approved", "withdrawn"].includes(item.status);
  return `<article class="management-item" data-submission-id="${escapeHtml(item.submissionId)}" data-revision="${escapeHtml(item.revision ?? 1)}">
    <header><div><strong>${escapeHtml(item.manifest?.name || item.submissionId)}</strong><small>修订 ${escapeHtml(item.revision ?? 1)} · ${escapeHtml(item.resolvedCommit?.slice?.(0, 12) || "等待解析")}</small></div>${statusBadge(item.status, submissionStatusLabels)}</header>
    <dl><dt>仓库</dt><dd>${escapeHtml(item.repositoryUrl || "-")}</dd><dt>Ref</dt><dd>${escapeHtml(item.requestedRef || item.ref || "-")}</dd></dl>
    ${diagnostics.length ? `<div class="diagnostic-list">${diagnostics.map((value) => `<p>${escapeHtml(typeof value === "string" ? value : value.message || JSON.stringify(value))}</p>`).join("")}</div>` : ""}
    ${reviews.length ? `<details><summary>审核记录（${reviews.length}）</summary>${reviews.map((review) => `<div class="review-history"><strong>${escapeHtml(review.reviewerName || "审核员")}</strong><span>${escapeHtml(review.decision)}</span><p>${escapeHtml(review.message || "")}</p></div>`).join("")}</details>` : ""}
    ${reviewer ? reviewForm(item) : mutable ? `<form class="submission-edit-form">
      <div class="form-grid"><label><span>仓库 URL</span><input name="repositoryUrl" type="url" required value="${escapeHtml(item.repositoryUrl || "")}"></label><label><span>Git ref</span><input name="ref" required value="${escapeHtml(item.requestedRef || item.ref || "main")}"></label></div>
      <label><span>镜像（每行一个）</span><textarea name="mirrorUrls" rows="2">${escapeHtml((item.mirrorUrls || []).join("\n"))}</textarea></label>
      <div class="item-actions"><button class="command-button" type="submit">保存并重新核验</button><button class="text-button danger-text" type="button" data-action="withdraw-submission">撤回</button></div>
      <p class="form-status" role="status"></p>
    </form>` : ""}
  </article>`;
}

function reviewForm(item) {
  return `<form class="review-form">
    <input type="hidden" name="expectedRevision" value="${escapeHtml(item.revision ?? 1)}">
    <fieldset><legend>问题分类</legend>${Object.entries(reviewReasonLabels).map(([value, label]) => `<label><input type="checkbox" name="reasonCodes" value="${value}"><span>${label}</span></label>`).join("")}</fieldset>
    <label><span>审核意见</span><textarea name="message" rows="3" required></textarea></label>
    <label><span>建议 Patch（JSON，可选，不会自动应用）</span><textarea name="proposedPatch" rows="3" placeholder='{"files": []}'></textarea></label>
    <div class="item-actions">
      <button class="command-button" type="submit" name="decision" value="changes_requested">要求修改</button>
      <button class="command-button danger-text" type="submit" name="decision" value="rejected">拒绝</button>
      <button class="command-button primary" type="submit" name="decision" value="approved">批准</button>
    </div><p class="form-status" role="status"></p>
  </form>`;
}

function proposalCard(item) {
  const revision = item.submission?.revision ?? item.revision ?? 1;
  const ownerActions = item.status === "awaiting_owner" ? `<div class="item-actions">
    <button class="command-button primary" type="button" data-proposal-action="accept">接受提案</button>
    <button class="command-button" type="button" data-proposal-action="request-changes">要求修改</button>
    <button class="command-button danger-text" type="button" data-proposal-action="reject">拒绝</button>
  </div>` : "";
  const contributorAction = !["released", "rejected", "withdrawn"].includes(item.status) ? `<button class="text-button danger-text" type="button" data-proposal-action="withdraw">撤回提案</button>` : "";
  return `<article class="management-item" data-proposal-id="${escapeHtml(item.proposalId)}" data-revision="${escapeHtml(revision)}">
    <header><div><strong>${escapeHtml(item.title || item.proposalId)}</strong><small>${escapeHtml(item.contributorName || "贡献者")} · ${escapeHtml(item.resolvedCommit?.slice?.(0, 12) || item.submissionId || "等待核验")}</small></div>${statusBadge(item.status, proposalStatusLabels)}</header>
    <p>${escapeHtml(item.summary || "")}</p>
    ${item.rejectionReason ? `<div class="diagnostic-list"><p>${escapeHtml(item.rejectionReason)}</p></div>` : ""}
    ${ownerActions}<div class="item-actions">${contributorAction}</div><p class="form-status" role="status"></p>
  </article>`;
}

async function loadManagement() {
  managementMessage("正在读取市场管理数据");
  const packageId = elements.managementPackageId.value.trim();
  try {
    if (state.managementTab === "submissions") {
      const body = await authenticatedApi("/api/v1/publisher/submissions");
      const submissions = rows(body, "submissions");
      elements.managementContent.innerHTML = submissions.length ? submissions.map((item) => submissionCard(item)).join("") : '<p class="management-message">还没有投稿。使用顶部“发布 Package”创建第一条投稿。</p>';
      return;
    }
    if (state.managementTab === "reviewer") {
      const body = await authenticatedApi("/api/v1/reviewer/submissions");
      const submissions = rows(body, "submissions");
      elements.managementContent.innerHTML = submissions.length ? submissions.map((item) => submissionCard(item, true)).join("") : '<p class="management-message">审核队列为空。</p>';
      return;
    }
    if (!packageId) {
      managementMessage("请输入 Package ID，或先从目录中选择一个 Package。", "warning");
      return;
    }
    if (state.managementTab === "proposals") {
      const body = await authenticatedApi(`/api/v1/packages/${encodeURIComponent(packageId)}/proposals`);
      const proposals = rows(body, "proposals");
      elements.managementContent.innerHTML = `${proposalCreateForm(packageId)}${proposals.length ? proposals.map(proposalCard).join("") : '<p class="management-message">这个 Package 还没有贡献提案。</p>'}`;
      return;
    }
    const body = await authenticatedApi(`/api/v1/packages/${encodeURIComponent(packageId)}/members`);
    const members = rows(body, "members");
    elements.managementContent.innerHTML = `${memberCreateForm(packageId)}<div class="member-list">${members.length ? members.map((member) => memberRow(member)).join("") : '<p class="management-message">暂无成员信息。</p>'}</div>`;
  } catch (error) {
    managementMessage(error.message, "error");
  }
}

function proposalCreateForm(packageId) {
  return `<form class="management-create-form" data-package-id="${escapeHtml(packageId)}">
    <header><div><strong>提交贡献提案</strong><small>提交完整 Git commit；维护者接受后仍需市场审核。</small></div></header>
    <div class="form-grid"><label><span>标题</span><input name="title" required></label><label><span>Git ref</span><input name="ref" value="main" required></label></div>
    <label><span>贡献仓库</span><input name="repositoryUrl" type="url" required placeholder="https://github.com/user/package.git"></label>
    <label><span>摘要</span><textarea name="summary" required rows="2"></textarea></label>
    <label><span>镜像（每行一个）</span><textarea name="mirrorUrls" rows="2"></textarea></label>
    <div class="item-actions"><button class="command-button primary" type="submit">提交提案</button></div><p class="form-status" role="status"></p>
  </form>`;
}

function memberCreateForm(packageId) {
  return `<form class="member-form" data-package-id="${escapeHtml(packageId)}">
    <label><span>用户 ID 或 GitHub 用户名</span><input name="userIdentity" required placeholder="usr_... 或 octocat"></label>
    <label><span>角色</span><select name="role"><option value="maintainer">维护者</option><option value="contributor">贡献者</option></select></label>
    <button class="command-button" type="submit">添加成员</button><p class="form-status" role="status"></p>
  </form>`;
}

function memberRow(member) {
  const user = member.user || {};
  return `<div class="member-row" data-user-id="${escapeHtml(member.userId || user.userId || "")}">
    <span class="account-avatar">${escapeHtml((user.login || "?").slice(0, 1).toUpperCase())}</span>
    <span><strong>${escapeHtml(user.name || user.login || member.userId)}</strong><small>@${escapeHtml(user.login || "-")}</small></span>
    <select data-member-role aria-label="成员角色"><option value="owner"${member.role === "owner" ? " selected" : ""}>所有者</option><option value="maintainer"${member.role === "maintainer" ? " selected" : ""}>维护者</option><option value="contributor"${member.role === "contributor" ? " selected" : ""}>贡献者</option></select>
    <button class="icon-button danger-text" type="button" data-action="remove-member" aria-label="移除成员">×</button>
  </div>`;
}

function closeDetail() {
  elements.detailPanel.classList.remove("open");
  if (window.matchMedia("(min-width: 981px)").matches) {
    elements.detailContent.classList.add("hidden");
    elements.detailEmpty.classList.remove("hidden");
  }
}

elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.q = elements.searchInput.value.trim();
  state.contributionType = elements.contributionSelect.value;
  state.nextCursor = null;
  loadPackages();
});

elements.categoryTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  state.category = button.dataset.category;
  state.nextCursor = null;
  document.querySelectorAll(".category-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
  loadPackages();
});

elements.packageList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-package-id]");
  if (card) showPackage(card.dataset.packageId);
});
elements.packageList.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-package-id]");
  if (card) { event.preventDefault(); showPackage(card.dataset.packageId); }
});
elements.refreshButton.addEventListener("click", () => loadPackages());
elements.loadMoreButton.addEventListener("click", () => loadPackages({ append: true }));
elements.closeDetailButton.addEventListener("click", closeDetail);
elements.issuesButton.addEventListener("click", () => openIssues());
elements.detailIssuesButton.addEventListener("click", () => openIssues(state.selectedPackage?.id || null));
elements.packageIssueList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-issue-number]");
  if (button) openIssues(state.selectedPackage?.id || null, button.dataset.issueNumber);
});
elements.issueList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-issue-number]");
  if (button) showIssue(button.dataset.issueNumber);
});
let issueSearchTimer;
elements.issueSearchInput.addEventListener("input", () => {
  clearTimeout(issueSearchTimer);
  issueSearchTimer = setTimeout(loadIssues, 250);
});
elements.issueStatusFilter.addEventListener("change", loadIssues);
elements.createIssueButton.addEventListener("click", prepareCreateIssue);
elements.issuesDialog.addEventListener("close", () => {
  state.selectedIssueNumber = null;
  elements.issueDetail.classList.remove("open");
  if (/^\/issues\//.test(location.pathname)) history.replaceState({}, "", "/");
});

elements.createIssueForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.createIssueForm);
  const button = elements.createIssueForm.querySelector("button[type=submit]");
  button.disabled = true;
  elements.createIssueStatus.textContent = "正在创建问题";
  try {
    const body = await issueApi("/api/v1/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        packageId: String(data.get("packageId") || "").trim() || undefined,
        component: String(data.get("component") || "").trim() || undefined,
        targetRepository: String(data.get("targetRepository") || "").trim() || undefined,
        reporterName: "WuxianPi 用户",
        title: data.get("title"),
        body: data.get("body"),
        visibility: data.get("maintainersOnly") ? "maintainers" : "public",
        source: "market",
        userConfirmed: true,
      }),
    });
    elements.createIssueDialog.close();
    await openIssues(body.issue.packageId || null, body.issue.issueNumber);
  } catch (error) {
    elements.createIssueStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

elements.issueDetail.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-action]");
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const status = form.querySelector("[role=status]");
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  status.textContent = "正在提交";
  try {
    if (form.dataset.action === "comment") {
      await issueApi(`/api/v1/issues/${form.dataset.issueNumber}/comments`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: data.get("body") }),
      });
    } else {
      const token = state.sessionToken || data.get("token");
      await api(`/api/v1/issues/${form.dataset.issueNumber}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: data.get("status"), githubUrl: String(data.get("githubUrl") || "").trim() || undefined }),
      });
    }
    await loadIssues();
    await showIssue(form.dataset.issueNumber, false);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

elements.issueDetail.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-verify]");
  if (!button) return;
  button.disabled = true;
  try {
    await issueApi(`/api/v1/issues/${button.dataset.issueNumber}/verify`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accepted: button.dataset.verify === "true" }),
    });
    await loadIssues();
    await showIssue(button.dataset.issueNumber, false);
  } catch (error) {
    setStatus(error.message);
  } finally {
    button.disabled = false;
  }
});
elements.accountButton.addEventListener("click", openAccount);
elements.manageButton.addEventListener("click", () => openManagement());
elements.openManagementButton.addEventListener("click", () => {
  elements.accountDialog.close();
  openManagement();
});

elements.tokenLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.tokenLoginForm);
  const button = elements.tokenLoginForm.querySelector("button[type=submit]");
  button.disabled = true;
  elements.authStatus.textContent = "正在验证 GitHub 身份";
  try {
    const body = await api("/api/v1/auth/github/token-exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken: data.get("githubToken"), kind: "browser", label: navigator.userAgent.slice(0, 120) }),
    });
    setSession(body);
    elements.tokenLoginForm.reset();
    elements.authStatus.textContent = "登录成功";
  } catch (error) {
    elements.authStatus.textContent = error.status === 404 ? "当前 Hub 服务版本尚未启用账户登录" : error.message;
  } finally {
    button.disabled = false;
  }
});

elements.deviceLoginButton.addEventListener("click", async () => {
  elements.deviceLoginButton.disabled = true;
  elements.authStatus.textContent = "正在申请设备代码";
  try {
    const body = await api("/api/v1/auth/github/device/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "browser", label: navigator.userAgent.slice(0, 120) }),
    });
    const authorization = firstValue(body, ["authorization", "deviceAuthorization"]) || body;
    state.deviceAuthorization = authorization;
    elements.deviceVerificationLink.href = authorization.verificationUri || authorization.verification_uri || "https://github.com/login/device";
    elements.deviceUserCode.textContent = authorization.userCode || authorization.user_code || "";
    elements.deviceCodePanel.classList.remove("hidden");
    elements.authStatus.textContent = "完成 GitHub 授权后回到这里继续";
  } catch (error) {
    elements.authStatus.textContent = error.status === 404 ? "当前 Hub 服务版本尚未启用设备授权" : error.message;
  } finally {
    elements.deviceLoginButton.disabled = false;
  }
});

elements.deviceCompleteButton.addEventListener("click", async () => {
  if (!state.deviceAuthorization) return;
  elements.deviceCompleteButton.disabled = true;
  elements.authStatus.textContent = "正在确认授权";
  try {
    const body = await api("/api/v1/auth/github/device/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceCode: state.deviceAuthorization.deviceCode || state.deviceAuthorization.device_code,
        kind: "browser",
        label: navigator.userAgent.slice(0, 120),
      }),
    });
    setSession(body);
    state.deviceAuthorization = null;
    elements.deviceCodePanel.classList.add("hidden");
    elements.authStatus.textContent = "登录成功";
  } catch (error) {
    elements.authStatus.textContent = error.status === 409 ? "GitHub 尚未确认授权，请稍后重试" : error.message;
  } finally {
    elements.deviceCompleteButton.disabled = false;
  }
});

elements.logoutButton.addEventListener("click", async () => {
  elements.logoutButton.disabled = true;
  try { await authenticatedApi("/api/v1/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); }
  catch (error) { if (error.status !== 401) elements.authStatus.textContent = error.message; }
  finally {
    clearSession("已退出当前 Hub 会话");
    elements.logoutButton.disabled = false;
  }
});

elements.managementTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-management-tab]");
  if (!button) return;
  state.managementTab = button.dataset.managementTab;
  elements.managementTabs.querySelectorAll("[data-management-tab]").forEach((item) => item.classList.toggle("active", item === button));
  void loadManagement();
});
elements.managementRefreshButton.addEventListener("click", () => void loadManagement());
elements.managementPackageId.addEventListener("change", () => {
  if (["proposals", "members"].includes(state.managementTab)) void loadManagement();
});

elements.managementContent.addEventListener("submit", async (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  const item = form.closest("[data-submission-id], [data-proposal-id]");
  const status = form.querySelector("[role=status]");
  const submitter = event.submitter;
  const data = new FormData(form);
  if (submitter) submitter.disabled = true;
  if (status) status.textContent = "正在提交";
  try {
    if (form.classList.contains("submission-edit-form")) {
      await authenticatedApi(`/api/v1/publisher/submissions/${encodeURIComponent(item.dataset.submissionId)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
          repositoryUrl: String(data.get("repositoryUrl") || "").trim(),
          ref: String(data.get("ref") || "").trim(),
          mirrorUrls: String(data.get("mirrorUrls") || "").split("\n").map((value) => value.trim()).filter(Boolean),
        }),
      });
    } else if (form.classList.contains("review-form")) {
      let proposedPatch = null;
      const rawPatch = String(data.get("proposedPatch") || "").trim();
      if (rawPatch) proposedPatch = JSON.parse(rawPatch);
      await authenticatedApi(`/api/v1/submissions/${encodeURIComponent(item.dataset.submissionId)}/reviews`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          expectedRevision: Number(data.get("expectedRevision")),
          decision: submitter?.value || "changes_requested",
          reasonCodes: data.getAll("reasonCodes"), message: data.get("message"), proposedPatch,
        }),
      });
    } else if (form.classList.contains("management-create-form")) {
      await authenticatedApi(`/api/v1/packages/${encodeURIComponent(form.dataset.packageId)}/proposals`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          title: data.get("title"), summary: data.get("summary"), repositoryUrl: data.get("repositoryUrl"), ref: data.get("ref"),
          mirrorUrls: String(data.get("mirrorUrls") || "").split("\n").map((value) => value.trim()).filter(Boolean),
        }),
      });
    } else if (form.classList.contains("member-form")) {
      const userIdentity = String(data.get("userIdentity") || "").trim();
      await authenticatedApi(`/api/v1/packages/${encodeURIComponent(form.dataset.packageId)}/members`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: userIdentity, login: userIdentity, role: data.get("role") }),
      });
    }
    await loadManagement();
  } catch (error) {
    if (status) status.textContent = error instanceof SyntaxError ? "建议 Patch 必须是有效 JSON" : error.message;
  } finally {
    if (submitter) submitter.disabled = false;
  }
});

elements.managementContent.addEventListener("click", async (event) => {
  const withdraw = event.target.closest("[data-action=withdraw-submission]");
  const proposalButton = event.target.closest("[data-proposal-action]");
  const removeMember = event.target.closest("[data-action=remove-member]");
  const button = withdraw || proposalButton || removeMember;
  if (!button) return;
  button.disabled = true;
  const container = button.closest("[data-submission-id], [data-proposal-id], [data-user-id]");
  const status = container.querySelector("[role=status]");
  try {
    if (withdraw) {
      await authenticatedApi(`/api/v1/submissions/${encodeURIComponent(container.dataset.submissionId)}/withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } else if (proposalButton) {
      const action = proposalButton.dataset.proposalAction;
      const message = ["reject", "request-changes"].includes(action) ? window.prompt(action === "reject" ? "审核消息（拒绝原因）" : "审核消息（需要修改的内容）") : "";
      if (["reject", "request-changes"].includes(action) && !message?.trim()) {
        if (status) status.textContent = "审核消息不能为空";
        return;
      }
      await authenticatedApi(`/api/v1/proposals/${encodeURIComponent(container.dataset.proposalId)}/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          expectedRevision: Number(container.dataset.revision),
          ...(message?.trim() ? { message: message.trim() } : {}),
        }),
      });
    } else {
      const packageId = elements.managementPackageId.value.trim();
      await authenticatedApi(`/api/v1/packages/${encodeURIComponent(packageId)}/members/${encodeURIComponent(container.dataset.userId)}`, { method: "DELETE" });
    }
    await loadManagement();
  } catch (error) {
    if (status) status.textContent = error.message;
    else managementMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

elements.managementContent.addEventListener("change", async (event) => {
  const select = event.target.closest("[data-member-role]");
  if (!select) return;
  const row = select.closest("[data-user-id]");
  const packageId = elements.managementPackageId.value.trim();
  select.disabled = true;
  try {
    await authenticatedApi(`/api/v1/packages/${encodeURIComponent(packageId)}/members/${encodeURIComponent(row.dataset.userId)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: select.value }),
    });
  } catch (error) {
    managementMessage(error.message, "error");
  } finally {
    select.disabled = false;
  }
});

elements.publishButton.addEventListener("click", () => {
  if (!state.identity) {
    openAccount();
    return;
  }
  elements.publishStatus.textContent = "";
  elements.publishDialog.showModal();
});

elements.publishForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.publishForm);
  const mirrorUrl = String(data.get("mirrorUrl") || "").trim();
  elements.publishStatus.textContent = "正在解析 Git ref";
  const button = elements.publishForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const body = await authenticatedApi("/api/v1/publisher/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryUrl: data.get("repositoryUrl"),
        ref: data.get("ref"),
        mirrorUrls: mirrorUrl ? [mirrorUrl] : [],
        metadata: { links: [], screenshots: [] },
      }),
    });
    const submission = body.submission;
    elements.publishStatus.textContent = `已登记 ${submission.submissionId}，状态：${submission.status}`;
    pollSubmission(submission.submissionId);
  } catch (error) {
    elements.publishStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function pollSubmission(id) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const body = await authenticatedApi(`/api/v1/publisher/submissions/${encodeURIComponent(id)}`);
      elements.publishStatus.textContent = `${id}：${body.submission.status}${body.submission.diagnostics[0] ? ` · ${body.submission.diagnostics[0]}` : ""}`;
      if (!["queued", "verifying"].includes(body.submission.status)) return;
    } catch (error) {
      elements.publishStatus.textContent = error.message;
      return;
    }
  }
}

async function bootstrap() {
  await loadIdentity();
  await loadPackages();
  const route = /^\/issues\/(\d+)$/.exec(location.pathname);
  if (route) await openIssues(null, route[1]);
}

window.addEventListener("popstate", () => {
  const route = /^\/issues\/(\d+)$/.exec(location.pathname);
  if (route) openIssues(null, route[1]);
  else if (elements.issuesDialog.open) elements.issuesDialog.close();
});

bootstrap();
