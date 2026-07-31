import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Download,
  ExternalLink,
  FileText,
  GitCommitHorizontal,
  GitMerge,
  Image,
  Link2,
  LoaderCircle,
  PackageCheck,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  ShieldCheck,
  Store,
  Trash2,
  Upload,
  UserRoundCog,
  WifiOff,
  X,
} from "lucide-react";
import type { AssistantSummary } from "@/lib/wuxianpi/contracts";
import {
  buildPublisherSubmissionInput,
  isAssistantBindableContribution,
  MARKET_CATEGORIES,
  MARKET_CATEGORY_LABELS,
  mergeLocalPackage,
  pruneExperienceSpaces,
  removeContributionBinding,
  runMutationWithRefresh,
  type HubPackageDetail,
  type HubPackageLink,
  type HubPackageSummary,
  type LocalContribution,
  type LocalPackage,
  type MarketCategory,
  type MarketPackageDetailPayload,
  type PackageOperation,
  type PublisherSubmissionDraft,
  type PublisherSubmissionInput,
} from "@/lib/package-market";
import { webApi, WebApiError } from "@/lib/web-api-client";

type MarketTab = "discover" | "installed" | "updates" | "logs";
type BusyAction = { key: string; label: string } | null;

const MARKET_TABS: Array<{ id: MarketTab; label: string; icon: typeof Store }> = [
  { id: "discover", label: "发现", icon: Store },
  { id: "installed", label: "已安装", icon: PackageCheck },
  { id: "updates", label: "更新", icon: RefreshCw },
  { id: "logs", label: "操作日志", icon: ScrollText },
];

const CONTRIBUTION_LABELS: Record<string, string> = {
  "pi.extension": "Pi Extension",
  "pi.skill": "Skill",
  "pi.prompt": "Prompt",
  "pi.theme": "主题",
  "mcp.server": "MCP",
  "wuxianpi.webExtension": "Web UI",
  "wuxianpi.renderer": "消息渲染器",
  "wuxianpi.assistantTemplate": "助手模板",
  "wuxianpi.context": "上下文",
  "wuxianpi.experience": "经验",
  "openhouse.app": "OpenHouse App",
  "service-manager.service": "后台服务",
  artifact: "构建产物",
};

function shortCommit(value?: string | null): string {
  return value ? value.slice(0, 10) : "-";
}

function formatDate(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isOfflineError(reason: unknown): boolean {
  return reason instanceof TypeError || (reason instanceof WebApiError && [502, 503, 504].includes(reason.status));
}

function localStatusLabel(status: LocalPackage["status"]): string {
  return {
    installed: "已安装",
    active: "使用中",
    disabled: "已停用",
    update_available: "可更新",
    merge_conflict: "合并冲突",
    build_failed: "构建失败",
    test_failed: "测试失败",
    activation_failed: "启用失败",
    revoked: "版本已撤回",
  }[status];
}

function operationStatusLabel(status: PackageOperation["status"]): string {
  return { queued: "排队中", running: "进行中", success: "成功", failed: "失败", cancelled: "已取消" }[status];
}

export function Marketplace({ assistants }: { assistants: AssistantSummary[] }) {
  const [tab, setTab] = useState<MarketTab>("discover");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MarketCategory | "">("");
  const [packages, setPackages] = useState<HubPackageSummary[]>([]);
  const [installed, setInstalled] = useState<LocalPackage[]>([]);
  const [updates, setUpdates] = useState<LocalPackage[]>([]);
  const [operations, setOperations] = useState<PackageOperation[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketPackageDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [publisherOpen, setPublisherOpen] = useState(false);
  const [bindingPackage, setBindingPackage] = useState<LocalPackage | null>(null);
  const detailRequestRef = useRef(0);

  const installedById = useMemo(() => new Map(installed.map((item) => [item.packageId, item])), [installed]);
  const selectedSummary = selectedPackageId ? updates.find((item) => item.packageId === selectedPackageId) ?? installedById.get(selectedPackageId) ?? null : null;
  const selectedDetail = selectedPackageId && detail?.installed?.packageId === selectedPackageId ? detail.installed : null;
  const selectedLocal = mergeLocalPackage(selectedSummary, selectedDetail);

  const loadLocal = useCallback(async () => {
    const [installedResult, updatesResult, operationsResult] = await Promise.allSettled([
      webApi.installedPackages(),
      webApi.packageUpdates(),
      webApi.packageOperations({ limit: 100 }),
    ]);
    if (installedResult.status === "fulfilled") setInstalled(installedResult.value.packages);
    if (updatesResult.status === "fulfilled") setUpdates(updatesResult.value.packages);
    if (operationsResult.status === "fulfilled") setOperations(operationsResult.value.operations);
    const rejected = [installedResult, updatesResult, operationsResult].find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }, []);

  const loadDiscover = useCallback(async () => {
    const result = await webApi.marketPackages({ q: query || undefined, category, limit: 100 });
    setPackages(result.packages);
    setOffline(false);
    return result.packages;
  }, [category, query]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWarning(null);
    const results = await Promise.allSettled([loadLocal(), loadDiscover()]);
    const localFailure = results[0].status === "rejected" ? results[0].reason : null;
    const marketFailure = results[1].status === "rejected" ? results[1].reason : null;
    if (marketFailure) {
      setOffline(isOfflineError(marketFailure));
      setError(errorText(marketFailure));
    } else if (localFailure) {
      setError(errorText(localFailure));
    }
    setLoading(false);
  }, [loadDiscover, loadLocal]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const openDetail = useCallback(async (packageId: string) => {
    const requestId = ++detailRequestRef.current;
    setSelectedPackageId(packageId);
    setDetail(null);
    setDetailLoading(true);
    try {
      const result = await webApi.marketPackage(packageId);
      if (requestId !== detailRequestRef.current) return;
      setDetail(result);
      setOffline(result.hubOffline === true);
      setWarning(result.hubOffline ? `Hub 状态刷新失败：${result.hubError ?? "Hub 暂时不可用"}` : null);
    } catch (reason) {
      if (requestId !== detailRequestRef.current) return;
      setDetail(null);
      if (isOfflineError(reason)) {
        setOffline(true);
        setWarning(`Hub 状态刷新失败：${errorText(reason)}`);
      }
      if (!installedById.has(packageId) && !updates.some((item) => item.packageId === packageId)) setError(errorText(reason));
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }, [installedById, updates]);

  const runAction = useCallback(async (key: string, label: string, action: () => Promise<PackageOperation>): Promise<boolean> => {
    setBusy({ key, label });
    setError(null);
    setWarning(null);
    try {
      const { result: operation, refreshError } = await runMutationWithRefresh(action, [
        () => loadLocal(),
        ...(selectedPackageId ? [() => openDetail(selectedPackageId)] : []),
      ]);
      setOperations((current) => [operation, ...current.filter((item) => item.operationId !== operation.operationId)]);
      setNotice(`${label}已提交`);
      if (refreshError) {
        setWarning(`操作已成功，但刷新状态失败：${errorText(refreshError)}`);
        if (isOfflineError(refreshError)) setOffline(true);
      }
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setBusy(null);
    }
  }, [loadLocal, openDetail, selectedPackageId]);

  const submitPublisher = useCallback(async (input: PublisherSubmissionInput) => {
    setBusy({ key: "publisher", label: "提交" });
    setError(null);
    try {
      const result = await webApi.submitMarketPackage(input);
      setPublisherOpen(false);
      setNotice(`提交 ${result.submission.submissionId} 已进入 ${result.submission.status}`);
    } catch (reason) {
      throw reason;
    } finally {
      setBusy(null);
    }
  }, []);

  const list = tab === "installed" ? installed : tab === "updates" ? updates : [];

  return (
    <section className="marketplace-page">
      <header className="marketplace-toolbar">
        <nav className="marketplace-tabs" aria-label="市场视图">
          {MARKET_TABS.map((item) => {
            const Icon = item.icon;
            const count = item.id === "installed" ? installed.length : item.id === "updates" ? updates.length : item.id === "logs" ? operations.length : undefined;
            return (
              <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
                <Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
                {count !== undefined && count > 0 && <em>{count}</em>}
              </button>
            );
          })}
        </nav>
        <div className="marketplace-toolbar-actions">
          <button type="button" className="icon-button" onClick={() => void refresh()} aria-label="刷新市场" title="刷新">
            <RefreshCw size={17} className={loading ? "spin" : ""} />
          </button>
          <button type="button" className="secondary-button market-publish-button" onClick={() => setPublisherOpen(true)}>
            <Upload size={16} />
            发布
          </button>
        </div>
      </header>

      {tab === "discover" && (
        <div className="marketplace-filters">
          <label className="market-search">
            <Search size={16} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Package" aria-label="搜索 Package" />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="清空搜索"><X size={15} /></button>}
          </label>
          <div className="market-category-filter" role="list" aria-label="Package 分类">
            <button type="button" className={!category ? "active" : ""} onClick={() => setCategory("")}>全部</button>
            {MARKET_CATEGORIES.map((item) => (
              <button key={item} type="button" className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{MARKET_CATEGORY_LABELS[item]}</button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className={`market-banner ${offline ? "offline" : "error"}`}>
          {offline ? <WifiOff size={18} /> : <CircleX size={18} />}
          <span>{offline ? "Hub 暂时不可用；本地已安装 Package 仍可管理。" : error}</span>
          <button type="button" onClick={() => { setError(null); void refresh(); }}>重试</button>
        </div>
      )}
      {warning && (
        <div className={`market-banner ${offline ? "offline" : "warning"}`}>
          {offline ? <WifiOff size={18} /> : <AlertTriangle size={18} />}
          <span>{warning}</span>
          <button type="button" onClick={() => setWarning(null)}>关闭</button>
        </div>
      )}

      {tab === "logs" ? (
        <OperationLog operations={operations} loading={loading} />
      ) : (
        <div className="marketplace-workspace">
          <div className="marketplace-list" aria-label={MARKET_TABS.find((item) => item.id === tab)?.label}>
            {loading && (tab !== "discover" || packages.length === 0) && <MarketLoading />}
            {!loading && tab === "discover" && packages.length === 0 && <MarketEmpty title="没有找到 Package" detail="更换搜索词或分类后重试。" />}
            {!loading && tab !== "discover" && list.length === 0 && (
              <MarketEmpty
                title={tab === "updates" ? "当前没有可用更新" : "还没有安装 Package"}
                detail={tab === "updates" ? "已安装内容均为当前市场版本。" : "从发现页选择 Package 安装。"}
              />
            )}
            {tab === "discover" && packages.map((item) => (
              <MarketPackageRow
                key={item.id}
                item={item}
                installed={installedById.get(item.id)}
                selected={selectedPackageId === item.id}
                onOpen={() => void openDetail(item.id)}
              />
            ))}
            {tab !== "discover" && list.map((item) => (
              <InstalledPackageRow key={item.packageId} item={item} selected={selectedPackageId === item.packageId} onOpen={() => void openDetail(item.packageId)} />
            ))}
          </div>

          <div className="marketplace-detail">
            {detailLoading && <MarketLoading />}
            {!detailLoading && !selectedPackageId && <MarketEmpty title="选择一个 Package" detail="查看版本、来源、检验结果与本地状态。" />}
            {!detailLoading && selectedPackageId && (
              <PackageDetail
                detail={detail}
                local={selectedLocal}
                offline={offline}
                busy={busy}
                onInstall={(packageId, releaseId) => void runAction(`install:${packageId}`, "安装", () => webApi.installMarketPackage(packageId, releaseId))}
                onUpdate={(packageId, releaseId) => void runAction(`update:${packageId}`, "更新", () => webApi.updateManagedPackage(packageId, releaseId))}
                onUninstall={(packageId) => {
                  if (window.confirm("卸载 Package？本地数据默认保留。")) void runAction(`uninstall:${packageId}`, "卸载", () => webApi.uninstallManagedPackage(packageId, true));
                }}
                onContribution={(packageId, contribution, enabled) => void runAction(
                  `contribution:${contribution.id}`,
                  enabled ? "启用贡献" : "停用贡献",
                  () => webApi.setPackageContribution(packageId, contribution.id, enabled),
                )}
                onCommit={(packageId) => {
                  const message = window.prompt("本地提交说明", "chore: preserve local package changes");
                  if (message?.trim()) void runAction(`commit:${packageId}`, "提交本地修改", () => webApi.commitPackageChanges(packageId, message.trim()));
                }}
                onBind={(item) => setBindingPackage(item)}
              />
            )}
          </div>
        </div>
      )}

      {publisherOpen && <PublisherSubmissionDialog busy={busy?.key === "publisher"} onClose={() => setPublisherOpen(false)} onSubmit={submitPublisher} />}
      {bindingPackage && (
        <AssistantBindingDialog
          pkg={bindingPackage}
          assistants={assistants.filter((assistant) => !assistant.manifest.archived && !assistant.id.startsWith("legacy-"))}
          busy={busy}
          onClose={() => setBindingPackage(null)}
          onSave={(assistantId, enabledContributionIds, experienceSpaces) => {
            void runAction(`bind:${bindingPackage.packageId}:${assistantId}`, "保存助手绑定", () => webApi.setPackageAssistantBinding(
              bindingPackage.packageId,
              assistantId,
              enabledContributionIds,
              experienceSpaces,
            )).then((saved) => {
              if (saved) setBindingPackage(null);
            });
          }}
        />
      )}
      {notice && <div className="wuxianpi-toast" role="status">{notice}</div>}
    </section>
  );
}

function MarketPackageRow({ item, installed, selected, onOpen }: { item: HubPackageSummary; installed?: LocalPackage; selected: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={`market-package-row ${selected ? "selected" : ""}`} onClick={onOpen}>
      <span className="market-package-icon"><Boxes size={20} /></span>
      <span className="market-package-copy">
        <strong>{item.name}</strong>
        <small>{item.summary}</small>
        <span className="market-chip-row">
          {item.categories.slice(0, 3).map((category) => <em key={category}>{MARKET_CATEGORY_LABELS[category]}</em>)}
          {installed && <em className="installed">{localStatusLabel(installed.status)}</em>}
        </span>
      </span>
      <ChevronRight size={17} aria-hidden="true" />
    </button>
  );
}

function InstalledPackageRow({ item, selected, onOpen }: { item: LocalPackage; selected: boolean; onOpen: () => void }) {
  const failed = item.status.includes("failed") || item.status === "merge_conflict";
  return (
    <button type="button" className={`market-package-row ${selected ? "selected" : ""}`} onClick={onOpen}>
      <span className={`market-package-icon ${failed ? "danger" : "local"}`}>{failed ? <AlertTriangle size={20} /> : <PackageCheck size={20} />}</span>
      <span className="market-package-copy">
        <strong>{item.name}</strong>
        <small>v{item.version} · {shortCommit(item.activeCommit)}</small>
        <span className="market-chip-row">
          <em className={failed ? "danger" : "installed"}>{localStatusLabel(item.status)}</em>
          {item.hasLocalChanges && <em>有本地修改</em>}
        </span>
      </span>
      <ChevronRight size={17} aria-hidden="true" />
    </button>
  );
}

function PackageDetail({
  detail,
  local,
  offline,
  busy,
  onInstall,
  onUpdate,
  onUninstall,
  onContribution,
  onCommit,
  onBind,
}: {
  detail: MarketPackageDetailPayload | null;
  local: LocalPackage | null;
  offline: boolean;
  busy: BusyAction;
  onInstall: (packageId: string, releaseId?: string) => void;
  onUpdate: (packageId: string, releaseId?: string) => void;
  onUninstall: (packageId: string) => void;
  onContribution: (packageId: string, contribution: LocalContribution, enabled: boolean) => void;
  onCommit: (packageId: string) => void;
  onBind: (pkg: LocalPackage) => void;
}) {
  const market = detail?.package ?? null;
  const packageId = market?.id ?? local?.packageId;
  if (!packageId) return <MarketEmpty title="Package 信息不可用" detail="刷新后重试。" />;
  const release = market?.latestRelease ?? null;
  const revokedRelease = detail?.releases.find((item) => item.status === "revoked") ?? null;
  const revoked = release?.status === "revoked" || local?.status === "revoked" || detail?.installPlan?.revoked || (!release && Boolean(revokedRelease));
  const verified = detail?.installPlan?.verification.status === "passed";
  const selfRelated = Boolean(local?.selfRelated || local?.contributions.some((item) => item.selfRelated));
  const isBusy = busy?.key.includes(packageId) ?? false;

  return (
    <article className="market-detail-content">
      <header className="market-detail-header">
        <div>
          <span className="eyebrow">{market?.publisher.name ?? "LOCAL PACKAGE"}</span>
          <h2>{market?.name ?? local?.name}</h2>
          <p>{market?.description ?? market?.summary ?? `当前活动版本 ${shortCommit(local?.activeCommit)}`}</p>
        </div>
        <div className="market-detail-actions">
          {!local && (
            <button type="button" className="primary-button" disabled={isBusy || revoked || !release || !verified} onClick={() => onInstall(packageId, detail?.installPlan?.releaseId ?? release?.releaseId)}>
              {isBusy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
              安装
            </button>
          )}
          {local?.updateReleaseId && (
            <button type="button" className="primary-button" disabled={isBusy || revoked || !verified} onClick={() => onUpdate(packageId, local.updateReleaseId ?? undefined)}>
              {isBusy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
              更新到 {local.updateVersion ?? "新版本"}
            </button>
          )}
          {local && (
            <button type="button" className="secondary-button" disabled={isBusy} onClick={() => onBind(local)}>
              <UserRoundCog size={16} />
              助手绑定
            </button>
          )}
          {local && (
            <button type="button" className="icon-button danger" disabled={isBusy} onClick={() => onUninstall(packageId)} aria-label="卸载 Package" title="卸载">
              <Trash2 size={17} />
            </button>
          )}
        </div>
      </header>

      {revoked && (
        <div className="market-banner error">
          <AlertTriangle size={18} />
          <span>{revokedRelease?.revocation?.reason ?? "该 Release 已被市场撤回，不允许新安装。"}</span>
        </div>
      )}

      {selfRelated && (
        <div className="market-banner warning">
          <AlertTriangle size={18} />
          <span>此 Package 涉及当前 WuxianPi 控制路径；更新、停用或卸载前将创建维修登记。</span>
        </div>
      )}

      {local?.failure && (
        <section className="market-failure-panel">
          <header><AlertTriangle size={18} /><strong>{localStatusLabel(local.status)}</strong></header>
          <p>{local.failure.message}</p>
          <strong>当前活动 Package 未被替换：{local.currentActivePreserved === false ? "请检查活动状态" : shortCommit(local.activeCommit)}</strong>
          {local.failure.conflicts && local.failure.conflicts.length > 0 && (
            <ul>{local.failure.conflicts.map((file) => <li key={file}><GitMerge size={14} /> <code>{file}</code></li>)}</ul>
          )}
          {local.failure.logPath && <code className="market-log-path">{local.failure.logPath}</code>}
        </section>
      )}

      {local && (
        <section className="market-detail-section">
          <header><h3>本地 Git</h3>{local.hasLocalChanges && <span className="status-pill warning">待提交</span>}</header>
          <div className="market-commit-grid">
            <CommitCell label="官方基线" value={local.baseCommit} />
            <CommitCell label="本地 HEAD" value={local.localHead} />
            <CommitCell label="目标版本" value={local.targetCommit} />
            <CommitCell label="当前活动" value={local.activeCommit} />
          </div>
          {local.hasLocalChanges && (
            <button type="button" className="secondary-button" disabled={isBusy} onClick={() => onCommit(packageId)}>
              <GitCommitHorizontal size={16} />
              提交本地修改
            </button>
          )}
        </section>
      )}

      {detail?.installPlan && (
        <section className="market-detail-section">
          <header><h3>版本与检验</h3><VerificationBadge status={detail.installPlan.verification.status} /></header>
          <dl className="market-metadata-grid">
            <div><dt>版本</dt><dd>{detail.installPlan.version}</dd></div>
            <div><dt>Release</dt><dd>{detail.installPlan.releaseId}</dd></div>
            <div><dt>批准 Commit</dt><dd><code>{shortCommit(detail.installPlan.approvedCommit)}</code></dd></div>
            <div><dt>Manifest SHA-256</dt><dd><code>{shortCommit(detail.installPlan.manifestDigest)}</code></dd></div>
          </dl>
          <div className="market-checks">{detail.installPlan.verification.checks.map((check) => <span key={check}><Check size={13} />{check}</span>)}</div>
        </section>
      )}

      {market && detail && <MarketSources market={market} detail={detail} offline={offline} />}

      {local && local.contributions.length > 0 && (
        <section className="market-detail-section">
          <header><h3>贡献</h3><span>{local.contributions.filter((item) => item.enabled).length}/{local.contributions.length} 已启用</span></header>
          <div className="market-contribution-list">
            {local.contributions.map((contribution) => (
              <div key={contribution.id} className="market-contribution-row">
                <span>
                  <strong>{contribution.name}</strong>
                  <small>{CONTRIBUTION_LABELS[contribution.type] ?? contribution.type} · <code>{contribution.id}</code></small>
                </span>
                {contribution.selfRelated && <span className="market-self-badge">维修登记</span>}
                <label className="switch" title={contribution.enabled ? "停用贡献" : "启用贡献"}>
                  <input
                    type="checkbox"
                    checked={contribution.enabled}
                    disabled={busy?.key === `contribution:${contribution.id}`}
                    onChange={(event) => onContribution(packageId, contribution, event.target.checked)}
                  />
                  <span />
                </label>
              </div>
            ))}
          </div>
        </section>
      )}

      {detail && detail.releases.length > 0 && (
        <section className="market-detail-section">
          <header><h3>Release 历史</h3></header>
          <div className="market-release-list">
            {detail.releases.map((item) => (
              <div key={item.releaseId}>
                <span><strong>v{item.version}</strong><small>{formatDate(item.publishedAt)} · <code>{shortCommit(item.approvedCommit)}</code></small></span>
                <span className={`status-pill ${item.status === "approved" ? "success" : "warning"}`}>{item.status === "approved" ? "已批准" : "已撤回"}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

function MarketSources({ market, detail, offline }: { market: HubPackageDetail; detail: MarketPackageDetailPayload; offline: boolean }) {
  return (
    <section className="market-detail-section">
      <header><h3>来源与产物</h3>{offline && <span className="status-pill warning">离线缓存</span>}</header>
      <div className="market-source-list">
        {(detail.installPlan?.gitSources ?? []).map((source) => (
          <a key={`${source.kind}:${source.url}`} href={source.url.replace(/\.git$/, "")} target="_blank" rel="noreferrer">
            <span><strong>{source.kind === "github" ? "GitHub 原站" : "Git 镜像"}</strong><small>{source.url}</small></span>
            <ExternalLink size={15} />
          </a>
        ))}
        {market.links.map((link) => (
          <a key={link.id} href={link.url} target="_blank" rel="noreferrer">
            <span><strong>{link.label}</strong><small>{link.kind} · {link.source}</small></span>
            <ExternalLink size={15} />
          </a>
        ))}
      </div>
      {(detail.installPlan?.artifacts.length ?? 0) > 0 && (
        <div className="market-artifact-list">
          {detail.installPlan!.artifacts.map((artifact) => (
            <div key={artifact.id}>
              <FileText size={17} />
              <span><strong>{artifact.fileName}</strong><small>{formatBytes(artifact.sizeBytes)} · {artifact.platforms.map((item) => `${item.os}/${item.arch}`).join(", ")}</small></span>
              <code>{shortCommit(artifact.sha256)}</code>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CommitCell({ label, value }: { label: string; value?: string | null }) {
  return <div><span>{label}</span><code title={value ?? ""}>{shortCommit(value)}</code></div>;
}

function VerificationBadge({ status }: { status: string }) {
  const passed = status === "passed";
  const pending = status === "queued" || status === "running";
  const label = passed ? "检验通过" : pending ? "等待检验" : "检验未通过";
  return <span className={`market-verification ${passed ? "passed" : pending ? "pending" : "failed"}`}>{passed ? <ShieldCheck size={14} /> : pending ? <LoaderCircle size={14} className={status === "running" ? "spin" : ""} /> : <AlertTriangle size={14} />}{label}</span>;
}

function OperationLog({ operations, loading }: { operations: PackageOperation[]; loading: boolean }) {
  if (loading && operations.length === 0) return <MarketLoading />;
  if (operations.length === 0) return <MarketEmpty title="还没有操作日志" detail="安装、更新和启停记录会显示在这里。" />;
  return (
    <div className="market-operation-list">
      {operations.map((operation) => {
        const failed = operation.status === "failed";
        return (
          <article key={operation.operationId} className={`market-operation ${failed ? "failed" : ""}`}>
            <div className="market-operation-status">{failed ? <CircleX size={19} /> : operation.status === "success" ? <CircleCheck size={19} /> : <LoaderCircle size={19} className={operation.status === "running" ? "spin" : ""} />}</div>
            <div className="market-operation-copy">
              <header><strong>{operation.packageName ?? operation.packageId}</strong><span>{operationStatusLabel(operation.status)}</span></header>
              <p>{operation.summary}</p>
              <small>{formatDate(operation.startedAt)} · {operation.type} · {operation.operationId}</small>
              {operation.error && <pre>{operation.error}</pre>}
              {operation.activePackagePreserved && <div className="market-active-preserved"><Check size={13} />当前活动 Package 未被替换</div>}
              {operation.events && operation.events.length > 0 && (
                <details><summary>查看过程日志</summary><pre>{operation.events.map((event) => `${event.at} [${event.level}] ${event.message}`).join("\n")}</pre></details>
              )}
              {operation.logPath && <code className="market-log-path">{operation.logPath}</code>}
            </div>
            {operation.selfRelated && (
              <div className="market-operation-maintenance"><AlertTriangle size={14} /><span>自身相关操作</span><small>{operation.maintenanceRecordPath ?? "已创建维修登记"}</small></div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function AssistantBindingDialog({
  pkg,
  assistants,
  busy,
  onClose,
  onSave,
}: {
  pkg: LocalPackage;
  assistants: AssistantSummary[];
  busy: BusyAction;
  onClose: () => void;
  onSave: (assistantId: string, enabledContributionIds: string[], experienceSpaces: Record<string, string>) => void;
}) {
  const [assistantId, setAssistantId] = useState(assistants[0]?.id ?? "");
  const initialBinding = pkg.assistantBindings.find((item) => item.assistantId === assistantId);
  const [enabledIds, setEnabledIds] = useState<string[]>(initialBinding?.enabledContributionIds ?? []);
  const [experienceSpaces, setExperienceSpaces] = useState<Record<string, string>>(initialBinding?.experienceSpaces ?? {});
  const [bindingLoading, setBindingLoading] = useState(false);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const bindableContributions = useMemo(() => pkg.contributions.filter(isAssistantBindableContribution), [pkg.contributions]);
  const packageContributionIds = useMemo(() => new Set(pkg.contributions.map((contribution) => contribution.id)), [pkg.contributions]);
  const bindableContributionIds = useMemo(() => new Set(bindableContributions.map((contribution) => contribution.id)), [bindableContributions]);

  useEffect(() => {
    if (!assistantId) return;
    let cancelled = false;
    setBindingLoading(true);
    setBindingError(null);
    void webApi.packageAssistantBinding(assistantId).then((next) => {
      if (cancelled) return;
      const nextEnabledIds = next.enabledContributionIds.filter((id) => !packageContributionIds.has(id) || bindableContributionIds.has(id));
      setEnabledIds(nextEnabledIds);
      setExperienceSpaces(pruneExperienceSpaces(nextEnabledIds, next.experienceSpaces));
    }).catch((reason) => {
      if (cancelled) return;
      setBindingError(errorText(reason));
    }).finally(() => {
      if (!cancelled) setBindingLoading(false);
    });
    return () => { cancelled = true; };
  }, [assistantId, bindableContributionIds, packageContributionIds]);

  const selectedAssistant = assistants.find((item) => item.id === assistantId);
  const isBusy = busy?.key === `bind:${pkg.packageId}:${assistantId}`;

  return (
    <div className="wuxianpi-modal-backdrop">
      <section className="market-dialog" role="dialog" aria-modal="true" aria-label="助手绑定">
        <header><div><span className="eyebrow">{pkg.name}</span><h2>助手绑定</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <div className="market-dialog-body">
          {assistants.length === 0 ? <MarketEmpty title="没有可绑定的助手" detail="请先创建一个主 AI 或功能助手。" /> : (
            <>
              <label className="market-field"><span>助手</span><select value={assistantId} onChange={(event) => setAssistantId(event.target.value)}>{assistants.map((assistant) => <option key={assistant.id} value={assistant.id}>{assistant.manifest.name}</option>)}</select></label>
              {bindingError && <div className="market-banner error"><CircleX size={17} /><span>{bindingError}</span></div>}
              {bindingLoading && <div className="market-binding-loading"><LoaderCircle size={16} className="spin" />正在读取助手当前绑定…</div>}
              <div className="market-binding-list">
                {bindableContributions.map((contribution) => {
                  const checked = enabledIds.includes(contribution.id);
                  const baseSpace = contribution.defaultExperienceSpaceId ?? `${contribution.id}.shared`;
                  const currentSpace = experienceSpaces[contribution.id] ?? baseSpace;
                  const isolatedSpace = `${baseSpace}.${assistantId}`;
                  return (
                    <div key={contribution.id} className="market-binding-row">
                      <label>
                        <input type="checkbox" checked={checked} onChange={(event) => {
                          if (event.target.checked) {
                            setEnabledIds((current) => [...new Set([...current, contribution.id])]);
                            return;
                          }
                          const next = removeContributionBinding(enabledIds, experienceSpaces, contribution.id);
                          setEnabledIds(next.enabledContributionIds);
                          setExperienceSpaces(next.experienceSpaces);
                        }} />
                        <span><strong>{contribution.name}</strong><small>{CONTRIBUTION_LABELS[contribution.type] ?? contribution.type}</small></span>
                      </label>
                      {contribution.type === "wuxianpi.experience" && checked && (
                        <div className="market-experience-choice">
                          <label><input type="radio" name={`experience:${contribution.id}`} checked={currentSpace === baseSpace} onChange={() => setExperienceSpaces((current) => ({ ...current, [contribution.id]: baseSpace }))} />共享经验</label>
                          <label><input type="radio" name={`experience:${contribution.id}`} checked={currentSpace === isolatedSpace} onChange={() => setExperienceSpaces((current) => ({ ...current, [contribution.id]: isolatedSpace }))} />独立经验</label>
                        </div>
                      )}
                    </div>
                  );
                })}
                {!bindingLoading && bindableContributions.length === 0 && <p className="market-inline-empty">此 Package 没有可绑定到助手的贡献</p>}
              </div>
            </>
          )}
        </div>
        <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={!selectedAssistant || isBusy || bindingLoading || Boolean(bindingError)} onClick={() => onSave(assistantId, enabledIds, pruneExperienceSpaces(enabledIds, experienceSpaces))}>{isBusy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存绑定</button></footer>
      </section>
    </div>
  );
}

function PublisherSubmissionDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (input: PublisherSubmissionInput) => Promise<void> }) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [ref, setRef] = useState("main");
  const [mirrors, setMirrors] = useState("");
  const [links, setLinks] = useState<PublisherSubmissionDraft["links"]>([]);
  const [screenshots, setScreenshots] = useState<PublisherSubmissionDraft["screenshots"]>([]);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await onSubmit(buildPublisherSubmissionInput({
        repositoryUrl,
        ref,
        mirrorUrls: mirrors.split(/\r?\n/),
        links,
        screenshots,
      }));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  return (
    <div className="wuxianpi-modal-backdrop">
      <section className="market-dialog publisher-dialog" role="dialog" aria-modal="true" aria-label="发布 Package">
        <header><div><span className="eyebrow">WUXIANPI HUB</span><h2>发布 Package</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <div className="market-dialog-body">
          {error && <div className="market-banner error"><CircleX size={17} /><span>{error}</span></div>}
          <div className="market-form-grid">
            <label className="market-field span-2"><span>GitHub 仓库</span><input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/author/package.git" /></label>
            <label className="market-field"><span>Ref</span><input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="v1.0.0" /></label>
            <label className="market-field span-2"><span>Git 镜像</span><textarea value={mirrors} onChange={(event) => setMirrors(event.target.value)} rows={3} placeholder="每行一个真实 Git 镜像 URL" /></label>
          </div>

          <section className="publisher-metadata-section">
            <header><div><Link2 size={17} /><strong>链接</strong></div><button type="button" className="secondary-button" onClick={() => setLinks((current) => [...current, { id: "", kind: "support", label: "", url: "" }])}><Plus size={14} />添加</button></header>
            {links.map((link, index) => (
              <div key={index} className="publisher-link-row">
                <input value={link.id} onChange={(event) => setLinks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item))} placeholder="唯一 ID" />
                <select value={link.kind} onChange={(event) => setLinks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, kind: event.target.value as HubPackageLink["kind"] } : item))}>
                  {(["homepage", "source", "documentation", "support", "license"] as const).map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                </select>
                <input value={link.label} onChange={(event) => setLinks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} placeholder="标签" />
                <input value={link.url} onChange={(event) => setLinks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item))} placeholder="https://..." />
                <button type="button" className="icon-button" onClick={() => setLinks((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label="删除链接"><Trash2 size={15} /></button>
              </div>
            ))}
            {links.length === 0 && <p className="market-inline-empty">未添加链接</p>}
          </section>

          <section className="publisher-metadata-section">
            <header><div><Image size={17} /><strong>截图</strong></div><button type="button" className="secondary-button" onClick={() => setScreenshots((current) => [...current, {
              id: "",
              alt: "",
              sha256: "",
              width: "1280",
              height: "720",
              mediaType: "image/webp",
              downloadSources: [{ kind: "github", url: "", priority: "100" }],
            }])}><Plus size={14} />添加</button></header>
            {screenshots.map((shot, index) => (
              <article key={index} className="publisher-screenshot-row">
                <header>
                  <strong>截图 {index + 1}</strong>
                  <button type="button" className="icon-button" onClick={() => setScreenshots((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label="删除截图"><Trash2 size={15} /></button>
                </header>
                <div className="publisher-screenshot-fields">
                  <input value={shot.id} onChange={(event) => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item))} placeholder="唯一 ID" />
                  <input value={shot.alt} onChange={(event) => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, alt: event.target.value } : item))} placeholder="截图说明" />
                  <input value={shot.sha256} onChange={(event) => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, sha256: event.target.value } : item))} placeholder="64 位小写 SHA-256" />
                  <select value={shot.mediaType} onChange={(event) => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, mediaType: event.target.value as PublisherSubmissionDraft["screenshots"][number]["mediaType"] } : item))} aria-label="截图格式"><option value="image/webp">WebP</option><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option></select>
                  <div className="publisher-dimensions"><input inputMode="numeric" value={shot.width} onChange={(event) => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, width: event.target.value } : item))} aria-label="截图宽度" /><span>×</span><input inputMode="numeric" value={shot.height} onChange={(event) => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, height: event.target.value } : item))} aria-label="截图高度" /></div>
                </div>
                <div className="publisher-source-list">
                  <header><span><strong>下载来源</strong><small>优先级数值越大越先尝试</small></span><button type="button" className="secondary-button" onClick={() => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, downloadSources: [...item.downloadSources, { kind: "mirror", url: "", priority: "80" }] } : item))}><Plus size={14} />来源</button></header>
                  {shot.downloadSources.map((source, sourceIndex) => (
                    <div key={sourceIndex} className="publisher-source-row">
                      <select value={source.kind} onChange={(event) => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, downloadSources: item.downloadSources.map((entry, entryIndex) => entryIndex === sourceIndex ? { ...entry, kind: event.target.value as "github" | "mirror" } : entry) } : item))} aria-label="来源类型"><option value="github">GitHub</option><option value="mirror">镜像</option></select>
                      <input value={source.url} onChange={(event) => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, downloadSources: item.downloadSources.map((entry, entryIndex) => entryIndex === sourceIndex ? { ...entry, url: event.target.value } : entry) } : item))} placeholder="HTTPS 下载地址" />
                      <input inputMode="numeric" min="0" max="1000" value={source.priority} onChange={(event) => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, downloadSources: item.downloadSources.map((entry, entryIndex) => entryIndex === sourceIndex ? { ...entry, priority: event.target.value } : entry) } : item))} aria-label="来源优先级" title="0 到 1000，数值越大优先级越高" />
                      <button type="button" className="icon-button" onClick={() => setScreenshots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, downloadSources: item.downloadSources.filter((_, entryIndex) => entryIndex !== sourceIndex) } : item))} aria-label="删除来源"><Trash2 size={15} /></button>
                    </div>
                  ))}
                </div>
              </article>
            ))}
            {screenshots.length === 0 && <p className="market-inline-empty">未添加截图</p>}
          </section>
        </div>
        <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || !repositoryUrl.trim() || !ref.trim()} onClick={() => void submit()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}提交审核</button></footer>
      </section>
    </div>
  );
}

function MarketLoading() {
  return <div className="market-loading"><LoaderCircle size={22} className="spin" /><span>正在加载…</span></div>;
}

function MarketEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="market-empty"><Boxes size={30} /><strong>{title}</strong><span>{detail}</span></div>;
}
