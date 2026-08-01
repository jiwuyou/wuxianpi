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

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body;
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
        <input name="token" type="password" required placeholder="Publisher 或管理员 Token" autocomplete="current-password">
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
      const token = data.get("token");
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
elements.publishButton.addEventListener("click", () => {
  elements.publishStatus.textContent = "";
  elements.publishDialog.showModal();
});

elements.publishForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.publishForm);
  const token = data.get("token");
  const mirrorUrl = String(data.get("mirrorUrl") || "").trim();
  elements.publishStatus.textContent = "正在解析 Git ref";
  const button = elements.publishForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const body = await api("/api/v1/publisher/submissions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        repositoryUrl: data.get("repositoryUrl"),
        ref: data.get("ref"),
        mirrorUrls: mirrorUrl ? [mirrorUrl] : [],
        metadata: { links: [], screenshots: [] },
      }),
    });
    const submission = body.submission;
    elements.publishStatus.textContent = `已登记 ${submission.submissionId}，状态：${submission.status}`;
    pollSubmission(submission.submissionId, token);
  } catch (error) {
    elements.publishStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function pollSubmission(id, token) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const body = await api(`/api/v1/publisher/submissions/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } });
      elements.publishStatus.textContent = `${id}：${body.submission.status}${body.submission.diagnostics[0] ? ` · ${body.submission.diagnostics[0]}` : ""}`;
      if (!["queued", "verifying"].includes(body.submission.status)) return;
    } catch (error) {
      elements.publishStatus.textContent = error.message;
      return;
    }
  }
}

async function bootstrap() {
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
