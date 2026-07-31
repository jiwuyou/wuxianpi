const state = {
  q: "",
  category: "",
  contributionType: "",
  nextCursor: null,
  packages: [],
  selectedId: null,
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
  } catch (error) {
    setStatus(error.message);
    closeDetail();
  }
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

loadPackages();
