"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderKanban, ListChecks, Store } from "lucide-react";
import type { AssistantSummary, CapabilityCatalog, GlobalWuxianPiConfigV1, WebExtensionSummary, Workspace } from "@/lib/wuxianpi/contracts";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import { useRuntimeDeploymentSync } from "@/hooks/useRuntimeDeploymentSync";
import { useTheme } from "@/hooks/useTheme";
import { useBrowserNavigation } from "@/lib/browser-navigation";
import { webApi } from "@/lib/web-api-client";
import { assistantAvatarBackground, assistantAvatarUrl } from "@/lib/assistant-avatar";
import { resolveStarterPrompt } from "@/lib/starter-prompts";
import { ChatWindow } from "./ChatWindow";
import type { ChatInputHandle } from "./ChatInput";
import { ExtensionHost } from "./wuxianpi/ExtensionHost";
import {
  cloneAssistant,
  exportAssistant,
  getCapabilityCatalog,
  getGlobalConfig,
  importAssistant,
  isUnavailableError,
  listAssistants,
  listWorkspaces,
  listWebExtensions,
  setAssistantArchived,
} from "./wuxianpi/api";

const ModelsConfig = lazy(() => import("./ModelsConfig").then((module) => ({ default: module.ModelsConfig })));
const AssistantEditor = lazy(() => import("./wuxianpi/AssistantEditor").then((module) => ({ default: module.AssistantEditor })));
const CapabilityCenter = lazy(() => import("./wuxianpi/CapabilityCenter").then((module) => ({ default: module.CapabilityCenter })));
const Marketplace = lazy(() => import("./wuxianpi/Marketplace").then((module) => ({ default: module.Marketplace })));
const WorkspaceManager = lazy(() => import("./wuxianpi/WorkspaceManager").then((module) => ({ default: module.WorkspaceManager })));
const BranchNavigator = lazy(() => import("./BranchNavigator").then((module) => ({ default: module.BranchNavigator })));

const LAST_SESSION_KEY = "wuxianpi:last-session-id";
const LAST_ASSISTANT_KEY = "wuxianpi:last-assistant-id";
const DEFAULT_ASSISTANT_ID = "wuxianpi";

type PanelView = "assistants" | "workspaces" | "capabilities" | "marketplace" | "settings" | `extension:${string}` | null;
type ShellOverlayContext = {
  panel: PanelView;
  l1Open: boolean;
  l2Open: boolean;
};

function avatarText(assistant: AssistantSummary): string {
  return assistant.manifest.name.trim().slice(0, 1).toUpperCase() || "π";
}

function AssistantAvatarVisual({ assistant }: { assistant: AssistantSummary }) {
  const url = assistantAvatarUrl(assistant);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let active = true;
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.onload = () => { if (active) setLoadedUrl(url); };
    image.src = url;
    return () => { active = false; };
  }, [url]);
  return url && loadedUrl === url
    ? <span style={{ backgroundImage: assistantAvatarBackground(url) }} />
    : avatarText(assistant);
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function formatTime(value?: string): string {
  if (!value) return "尚未对话";
  const date = new Date(value);
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function groupSessionsByAssistant(assistants: AssistantSummary[], sessions: SessionInfo[]) {
  const map = new Map<string, SessionInfo[]>(assistants.map((assistant) => [assistant.id, []]));
  const unbound: SessionInfo[] = [];
  const unavailable: SessionInfo[] = [];
  for (const session of sessions) {
    if (session.ownershipState === "unbound" || !session.assistantId) unbound.push(session);
    else if (map.has(session.assistantId)) map.get(session.assistantId)?.push(session);
    else unavailable.push(session);
  }
  for (const items of [...map.values(), unbound, unavailable]) items.sort((a, b) => b.modified.localeCompare(a.modified));
  return { map, unbound, unavailable };
}

function rememberChat(assistantId: string | null, sessionId: string | null) {
  try {
    if (assistantId) localStorage.setItem(LAST_ASSISTANT_KEY, assistantId);
    else localStorage.removeItem(LAST_ASSISTANT_KEY);
    if (sessionId) localStorage.setItem(LAST_SESSION_KEY, sessionId);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    // ignore quota / private mode
  }
}

export function AppShell() {
  const router = useBrowserNavigation();
  const searchParams = router.searchParams;
  const { isDark, toggleTheme } = useTheme();
  useRuntimeDeploymentSync();
  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [extensions, setExtensions] = useState<WebExtensionSummary[]>([]);
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [globalConfig, setGlobalConfig] = useState<GlobalWuxianPiConfigV1 | null>(null);
  const [selectedAssistant, setSelectedAssistant] = useState<AssistantSummary | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);
  const [editorAssistant, setEditorAssistant] = useState<AssistantSummary | null | undefined>(undefined);
  const [modelsOpen, setModelsOpen] = useState(false);
  // The model service is a page-level overlay. Preserve the page/drawer that
  // opened it so closing returns the user to the exact previous context.
  const [modelsReturnContext, setModelsReturnContext] = useState<ShellOverlayContext | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [platformUnavailable, setPlatformUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [l1Open, setL1Open] = useState(false);
  const [l2Open, setL2Open] = useState(false);
  const [panel, setPanel] = useState<PanelView>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const importRef = useRef<HTMLInputElement | null>(null);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeRef = useRef<((leafId: string | null) => void) | null>(null);

  const loadSessions = useCallback(async () => {
    const loaded = await webApi.listSessions();
    setSessions(loaded);
    return loaded;
  }, []);

  const loadPlatform = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await loadSessions();
      try {
        const [assistantList, capabilityCatalog, config, extensionList, workspaceList] = await Promise.all([
          listAssistants({ includeArchived: true }),
          getCapabilityCatalog(),
          getGlobalConfig(),
          listWebExtensions(),
          listWorkspaces({ includeArchived: true }),
        ]);
        setAssistants(assistantList);
        setCatalog(capabilityCatalog);
        setGlobalConfig(config);
        setExtensions(extensionList);
        setWorkspaces(workspaceList);
        setPlatformUnavailable(false);
      } catch (reason) {
        if (!isUnavailableError(reason)) throw reason;
        setAssistants([]);
        setWorkspaces([]);
        setPlatformUnavailable(true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [loadSessions]);

  useEffect(() => { void loadPlatform(); }, [loadPlatform]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const sessionsByAssistant = useMemo(() => groupSessionsByAssistant(assistants, sessions), [assistants, sessions]);

  const visibleAssistants = useMemo(() => assistants
    .filter((assistant) => includeArchived || !assistant.manifest.archived)
    .filter((assistant) => !search || `${assistant.manifest.name} ${assistant.manifest.description ?? ""}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (a.id === DEFAULT_ASSISTANT_ID && b.id !== DEFAULT_ASSISTANT_ID) return -1;
      if (b.id === DEFAULT_ASSISTANT_ID && a.id !== DEFAULT_ASSISTANT_ID) return 1;
      return (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "");
    }), [assistants, includeArchived, search]);

  const defaultAssistant = useMemo(() => {
    return assistants.find((item) => item.id === DEFAULT_ASSISTANT_ID && !item.manifest.archived)
      ?? assistants.find((item) => !item.manifest.archived)
      ?? assistants[0]
      ?? null;
  }, [assistants]);

  const openNewChat = useCallback((assistant: AssistantSummary, prompt?: string, workspaceId: string | null = null) => {
    const activeWorkspaceId = workspaceId && workspaces.some((workspace) => workspace.id === workspaceId && !workspace.archived)
      ? workspaceId
      : null;
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSelectedAssistant(assistant);
    setSelectedSession(null);
    setSelectedWorkspaceId(activeWorkspaceId);
    setInitialPrompt(prompt ?? null);
    setChatKey((key) => key + 1);
    rememberChat(assistant.id, null);
    router.replace("/");
    setL2Open(false);
    setL1Open(false);
    setPanel(null);
  }, [router, workspaces]);

  const openSession = useCallback((session: SessionInfo) => {
    setBranchTree([]);
    setBranchActiveLeafId(null);
    const owner = session.assistantId ? assistants.find((assistant) => assistant.id === session.assistantId) ?? null : null;
    setSelectedAssistant(owner);
    setSelectedSession(session);
    setSelectedWorkspaceId(session.workspaceId);
    setInitialPrompt(null);
    setChatKey((key) => key + 1);
    rememberChat(session.assistantId, session.id);
    router.replace(`/?session=${encodeURIComponent(session.id)}`);
    setL2Open(false);
    setL1Open(false);
    setPanel(null);
  }, [assistants, router]);

  const openModelsPage = useCallback(() => {
    setModelsReturnContext((current) => current ?? { panel, l1Open, l2Open });
    setModelsOpen(true);
    // A model page is independent from the navigation drawers. Keep the
    // previous values in modelsReturnContext and restore them on close.
    setPanel(null);
    setL1Open(false);
    setL2Open(false);
  }, [l1Open, l2Open, panel]);

  const closeModelsPage = useCallback(() => {
    setModelsOpen(false);
    if (modelsReturnContext) {
      setPanel(modelsReturnContext.panel);
      setL1Open(modelsReturnContext.l1Open);
      setL2Open(modelsReturnContext.l2Open);
    }
    setModelsReturnContext(null);
  }, [modelsReturnContext]);

  // Bootstrap: always land on chat (URL session → last session → default assistant).
  useEffect(() => {
    if (loading || bootstrapped) return;
    if (error && assistants.length === 0) {
      setBootstrapped(true);
      return;
    }

    const requested = searchParams.get("session");
    if (requested) {
      const target = sessions.find((session) => session.id === requested);
      if (target) {
        openSession(target);
        setBootstrapped(true);
        return;
      }
    }

    let lastSessionId: string | null = null;
    let lastAssistantId: string | null = null;
    try {
      lastSessionId = localStorage.getItem(LAST_SESSION_KEY);
      lastAssistantId = localStorage.getItem(LAST_ASSISTANT_KEY);
    } catch {
      // ignore
    }

    if (lastSessionId) {
      const target = sessions.find((session) => session.id === lastSessionId);
      if (target) {
        openSession(target);
        setBootstrapped(true);
        return;
      }
    }

    const preferred = (lastAssistantId && assistants.find((item) => item.id === lastAssistantId && !item.manifest.archived))
      || defaultAssistant;
    if (preferred) {
      openNewChat(preferred);
      setBootstrapped(true);
      return;
    }

    setBootstrapped(true);
  }, [assistants, bootstrapped, defaultAssistant, error, loading, openNewChat, openSession, searchParams, sessions]);

  // Keep URL session in sync when already bootstrapped (e.g. browser back/forward).
  useEffect(() => {
    if (!bootstrapped || loading) return;
    const requested = searchParams.get("session");
    if (!requested) return;
    if (selectedSession?.id === requested) return;
    const target = sessions.find((session) => session.id === requested);
    if (target) openSession(target);
  }, [bootstrapped, loading, openSession, searchParams, selectedSession?.id, sessions]);

  useEffect(() => {
    if (!modelsOpen && !l1Open && !l2Open && !panel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (modelsOpen) closeModelsPage();
      else if (panel) setPanel(null);
      else if (l1Open) setL1Open(false);
      else if (l2Open) setL2Open(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModelsPage, l1Open, l2Open, modelsOpen, panel]);

  const handleImport = async (file: File) => {
    try {
      const defaultId = file.name.replace(/\.(zip|wuxianpi)$/i, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "imported-assistant";
      const requested = window.prompt("助手 ID", defaultId);
      if (!requested) return;
      const assistant = await importAssistant(file, requested);
      setAssistants((current) => [assistant, ...current.filter((item) => item.id !== assistant.id)]);
      setNotice(`已导入 ${assistant.manifest.name}`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleClone = async (assistant: AssistantSummary) => {
    const targetId = window.prompt("新助手 ID", `${assistant.id}-copy`);
    if (!targetId) return;
    try {
      const copy = await cloneAssistant(assistant.id, targetId);
      setAssistants((current) => [copy, ...current]);
      setNotice(`已复制为 ${copy.manifest.name}`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleArchive = async (assistant: AssistantSummary) => {
    try {
      const next = await setAssistantArchived(assistant.id, !assistant.manifest.archived);
      setAssistants((current) => current.map((item) => item.id === next.id ? next : item));
      setNotice(next.manifest.archived ? "助手已归档" : "助手已恢复");
      if (selectedAssistant?.id === next.id && next.manifest.archived && defaultAssistant) {
        openNewChat(defaultAssistant);
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const selectedExtensions = useMemo(() => {
    if (!selectedAssistant) return [];
    const ids = selectedAssistant.manifest.webExtensions;
    if (ids === "inherit" || ids === undefined) {
      const defaults = globalConfig?.defaults.webExtensions ?? [];
      return extensions.filter((extension) => extension.enabled && defaults.includes(extension.id));
    }
    return extensions.filter((extension) => extension.enabled && ids.includes(extension.id));
  }, [extensions, globalConfig?.defaults.webExtensions, selectedAssistant]);

  const extensionNavigationItems = useMemo(() => extensions.flatMap((extension) =>
    (extension.enabled ? extension.manifest.contributes?.navigationItems ?? [] : []).map((item) => ({
      extension,
      item,
      panelId: `extension:${extension.id}:${item.id}` as const,
    }))), [extensions]);
  const activeExtensionNavigation = panel?.startsWith("extension:")
    ? extensionNavigationItems.find((candidate) => candidate.panelId === panel)
    : undefined;

  const selectedWorkspace = useMemo(
    () => selectedWorkspaceId ? workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null : null,
    [selectedWorkspaceId, workspaces],
  );
  const currentWorkspaceName = selectedSession
    ? selectedSession.workspaceName ?? (selectedSession.workspaceId ? selectedWorkspace?.name ?? "工作区不可用" : "日常对话")
    : selectedWorkspace?.name ?? "日常对话";
  const currentAssistantName = selectedAssistant?.manifest.name
    ?? (selectedSession?.assistantId ? "助手不可用" : selectedSession ? "未归属 Pi 会话" : "WuxianPi");

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeRef.current = onLeafChange;
  }, []);

  const openPanel = (next: PanelView) => {
    setPanel(next);
    setL1Open(false);
  };

  const hostAssistantId = assistants.find((assistant) => !assistant.manifest.archived)?.id;
  const hostAssistantPath = assistants.find((assistant) => assistant.id === hostAssistantId)?.path;
  const extensionHostAssistantId = selectedSession?.assistantId ?? selectedAssistant?.id ?? hostAssistantId;
  const panelTitle = activeExtensionNavigation?.item.title
    ?? (panel === "assistants" ? "助手库" : panel === "workspaces" ? "工作区" : panel === "capabilities" ? "能力中心"
      : panel === "marketplace" ? "WuxianPi 市场" : "设置");

  return (
    <main className="wuxianpi-app chat-mode shell-chat-default">
      <header className="mobile-chat-header">
        <button className="icon-button" type="button" onClick={() => { setL1Open(true); setL2Open(false); }} aria-label="打开菜单" title="菜单">☰</button>
        <button
          type="button"
          className="mobile-chat-title-button"
          onClick={() => { setL2Open(true); setL1Open(false); }}
          aria-label="打开对话列表"
        >
          <div className="assistant-mini-avatar">
            {selectedAssistant ? <AssistantAvatarVisual assistant={selectedAssistant} /> : selectedSession ? "P" : "π"}
          </div>
          <div className="mobile-chat-title">
            <strong>{currentAssistantName}</strong>
            <small>{selectedSession?.name || currentWorkspaceName || selectedAssistant?.manifest.description || (loading ? "加载中…" : "开始对话")}</small>
          </div>
        </button>
        <button className="icon-button" type="button" onClick={() => { setL2Open(true); setL1Open(false); }} aria-label="对话列表" title="对话列表">≡</button>
        <button
          className="icon-button"
          type="button"
          onClick={() => setEditorAssistant(selectedAssistant ?? undefined)}
          disabled={!selectedAssistant}
          aria-label="助手设置"
          title="助手设置"
        >
          ⋯
        </button>
      </header>

      {selectedSession && (
        <Suspense fallback={null}>
          <BranchNavigator
            tree={branchTree}
            activeLeafId={branchActiveLeafId}
            onLeafChange={(leafId) => branchLeafChangeRef.current?.(leafId)}
            hasSession
          />
        </Suspense>
      )}

      <div className="mobile-chat-body">
        {error && !selectedAssistant && !selectedSession && (
          <div className="wuxianpi-state error shell-inline-state">
            <span>{error}</span>
            <button type="button" onClick={() => void loadPlatform()}>重试</button>
          </div>
        )}
        {!error && !selectedAssistant && !selectedSession && (
          <div className="empty-hero shell-chat-empty">
            <div>∞</div>
            <h2>{loading ? "正在准备助手…" : "还没有可用助手"}</h2>
            <p>{loading ? "请稍候" : "从左侧菜单创建助手，或导入已有配置。"}</p>
            {!loading && (
              <button type="button" className="primary-button" disabled={platformUnavailable} onClick={() => setPanel("assistants")}>
                管理助手
              </button>
            )}
          </div>
        )}
        {(selectedAssistant || selectedSession) && (
          <ChatWindow
            key={chatKey}
            session={selectedSession}
            newSessionCwd={selectedSession ? null : selectedWorkspace?.rootCwd ?? null}
            newSessionWorkspaceId={selectedSession ? null : selectedWorkspace?.id ?? null}
            assistantId={selectedSession ? selectedSession.assistantId ?? undefined : selectedAssistant?.id}
            assistant={selectedAssistant ?? undefined}
            workspaceName={currentWorkspaceName}
            workspaces={workspaces}
            selectedWorkspaceId={selectedSession ? selectedSession.workspaceId : selectedWorkspaceId}
            onWorkspaceChange={selectedSession ? undefined : (workspaceId) => {
              setSelectedWorkspaceId(workspaceId);
              setChatKey((key) => key + 1);
            }}
            webExtensions={selectedExtensions}
            defaultTts={globalConfig?.defaults.tts}
            onAgentEnd={() => void loadSessions()}
            onSessionCreated={(session) => {
              setSelectedSession(session);
              rememberChat(session.assistantId, session.id);
              router.replace(`/?session=${encodeURIComponent(session.id)}`);
              void loadSessions();
            }}
            onSessionForked={(id) => {
              void loadSessions().then((items) => {
                const target = items.find((item) => item.id === id);
                if (target) openSession(target);
              });
            }}
            chatInputRef={chatInputRef}
            initialPrompt={initialPrompt}
            initialPromptKey={initialPrompt ? `${selectedAssistant?.id ?? selectedSession?.assistantId ?? "unbound"}:${initialPrompt}` : null}
            onInitialPromptQueued={() => setInitialPrompt(null)}
            onOpenModelsConfig={openModelsPage}
            onBranchDataChange={handleBranchDataChange}
          />
        )}
      </div>

      {/* L1 — navigation / settings (does not replace L2 content) */}
      <div className={`shell-drawer-backdrop ${l1Open ? "open" : ""}`} onClick={() => setL1Open(false)} aria-hidden={!l1Open} />
      <aside className={`shell-drawer shell-drawer-l1 ${l1Open ? "open" : ""}`} aria-hidden={!l1Open} aria-label="主菜单">
        <header className="shell-drawer-header">
          <div>
            <span className="brand-mark">∞π</span>
            <strong>WuxianPi</strong>
            <small>菜单与设置</small>
          </div>
          <button type="button" className="icon-button" onClick={() => setL1Open(false)} aria-label="关闭">×</button>
        </header>
        {selectedAssistant && (
          <section className="shell-drawer-current">
            <div className="assistant-mini-avatar"><AssistantAvatarVisual assistant={selectedAssistant} /></div>
            <div>
              <strong>{selectedAssistant.manifest.name}</strong>
              <small>当前助手</small>
            </div>
            <button type="button" className="secondary-button compact" onClick={() => openNewChat(selectedAssistant, undefined, selectedSession?.workspaceId ?? selectedWorkspaceId)}>新对话</button>
          </section>
        )}
        <nav className="shell-drawer-nav">
          <button type="button" onClick={() => openPanel("assistants")}><span>∞</span><div><strong>助手库</strong><small>创建、编辑、导入导出</small></div><em>›</em></button>
          <button type="button" onClick={() => { setL2Open(true); setL1Open(false); }}><span>◌</span><div><strong>全部对话</strong><small>按助手分组的历史列表</small></div><em>›</em></button>
          {extensionNavigationItems.map(({ extension, item, panelId }) => (
            <button type="button" key={panelId} onClick={() => openPanel(panelId)}>
              <span><ListChecks size={18} /></span>
              <div><strong>{item.title}</strong><small>{extension.manifest.description ?? extension.manifest.name}</small></div><em>›</em>
            </button>
          ))}
          <button type="button" onClick={() => openPanel("workspaces")}><span><FolderKanban size={18} /></span><div><strong>工作区</strong><small>项目路径、指令与记忆</small></div><em>›</em></button>
          <button type="button" onClick={() => openPanel("capabilities")}><span>⌁</span><div><strong>能力中心</strong><small>模型默认、工具、MCP、TTS</small></div><em>›</em></button>
          <button type="button" onClick={() => openPanel("marketplace")}><span><Store size={18} /></span><div><strong>WuxianPi 市场</strong><small>Package、更新与助手绑定</small></div><em>›</em></button>
          <button type="button" onClick={() => openPanel("settings")}><span>⚙</span><div><strong>设置</strong><small>主题、模型服务、运行信息</small></div><em>›</em></button>
        </nav>
        <footer className="shell-drawer-footer">
          <small>v{import.meta.env.VITE_APP_VERSION ?? "0.1.0"} · Pi {import.meta.env.VITE_PI_VERSION ?? "?"}</small>
          <span className={`status-pill ${platformUnavailable ? "warning" : "success"}`}>{platformUnavailable ? "助手服务不可用" : "在线"}</span>
        </footer>
      </aside>

      {/* L2 — global conversation list, grouped by assistant (independent of L1 selection) */}
      <div className={`shell-drawer-backdrop ${l2Open ? "open" : ""}`} onClick={() => setL2Open(false)} aria-hidden={!l2Open} />
      <aside className={`shell-drawer shell-drawer-l2 ${l2Open ? "open" : ""}`} aria-hidden={!l2Open} aria-label="对话列表">
        <header className="shell-drawer-header">
          <div>
            <span className="eyebrow">CHATS</span>
            <strong>对话</strong>
            <small>按助手分组 · 与菜单互不替换</small>
          </div>
          <button type="button" className="icon-button" onClick={() => setL2Open(false)} aria-label="关闭">×</button>
        </header>
        <div className="shell-drawer-toolbar">
          <button
            type="button"
            className="primary-button"
            disabled={!selectedAssistant && !defaultAssistant}
            onClick={() => {
              const target = selectedAssistant ?? defaultAssistant;
              if (target) openNewChat(target);
            }}
          >
            新对话
          </button>
        </div>
        <div className="shell-drawer-scroll">
          <ConversationDrawer
            assistants={assistants}
            grouped={sessionsByAssistant}
            activeSessionId={selectedSession?.id ?? null}
            onOpen={openSession}
            onNew={openNewChat}
          />
        </div>
      </aside>

      {/* Full-screen panels opened from L1 */}
      {panel && (
        <div className="shell-panel-layer" role="dialog" aria-modal="true">
          <header className="shell-panel-header">
            <button type="button" className="icon-button" onClick={() => setPanel(null)} aria-label="返回">‹</button>
            <strong>{panelTitle}</strong>
            <span className="shell-panel-header-spacer" />
          </header>
          <div className="shell-panel-body">
            {panel === "assistants" && (
              <AssistantsPanel
                loading={loading}
                error={error}
                platformUnavailable={platformUnavailable}
                visibleAssistants={visibleAssistants}
                search={search}
                setSearch={setSearch}
                onRetry={() => void loadPlatform()}
                onCreate={() => setEditorAssistant(null)}
                onImport={() => importRef.current?.click()}
                onOpenChat={(assistant, prompt) => openNewChat(assistant, prompt)}
                onEdit={(assistant) => setEditorAssistant(assistant)}
                onClone={(assistant) => void handleClone(assistant)}
                onExport={(assistant) => void exportAssistant(assistant.id).catch((reason) => setNotice(String(reason)))}
                onArchive={(assistant) => void handleArchive(assistant)}
              />
            )}
            {panel === "capabilities" && (
              <Suspense fallback={<div className="wuxianpi-state">正在加载能力中心…</div>}>
                <CapabilityCenter
                  catalog={catalog}
                  config={globalConfig}
                  extensions={extensions}
                  hostAssistantId={hostAssistantId}
                  hostAssistantPath={hostAssistantPath}
                  loading={loading}
                  error={error}
                  onReload={() => void loadPlatform()}
                  onConfigChanged={setGlobalConfig}
                  onOpenModels={openModelsPage}
                />
              </Suspense>
            )}
            {panel === "workspaces" && (
              <Suspense fallback={<div className="wuxianpi-state">正在加载工作区…</div>}>
                <WorkspaceManager workspaces={workspaces} onChanged={(next) => {
                  setWorkspaces(next);
                  if (selectedWorkspaceId && !next.some((workspace) => workspace.id === selectedWorkspaceId)) setSelectedWorkspaceId(null);
                }} />
              </Suspense>
            )}
            {panel === "marketplace" && (
              <Suspense fallback={<div className="wuxianpi-state">正在加载 WuxianPi 市场…</div>}>
                <Marketplace assistants={assistants} />
              </Suspense>
            )}
            {panel === "settings" && (
              <SettingsPage
                isDark={isDark}
                toggleTheme={toggleTheme}
                includeArchived={includeArchived}
                setIncludeArchived={setIncludeArchived}
                platformUnavailable={platformUnavailable}
                onOpenModels={openModelsPage}
              />
            )}
            {activeExtensionNavigation && extensionHostAssistantId && (
              <ExtensionHost
                extension={activeExtensionNavigation.extension}
                entry={activeExtensionNavigation.item.entry}
                assistantId={extensionHostAssistantId}
                sessionId={selectedSession?.id}
                className="shell-extension-page"
                initialHeight={900}
                onNotify={setNotice}
                onOpenSession={(sessionId) => {
                  void loadSessions().then((items) => {
                    const target = items.find((item) => item.id === sessionId);
                    if (target) openSession(target);
                  });
                }}
              />
            )}
          </div>
        </div>
      )}

      <input
        ref={importRef}
        hidden
        type="file"
        accept="application/zip,.zip,.wuxianpi"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleImport(file);
          event.target.value = "";
        }}
      />

      {editorAssistant !== undefined && (
        <Suspense fallback={<div className="wuxianpi-modal-backdrop"><div className="wuxianpi-state">正在加载助手编辑器…</div></div>}>
          <AssistantEditor
            assistant={editorAssistant}
            catalog={catalog}
            config={globalConfig}
            onClose={() => setEditorAssistant(undefined)}
            onManageWorkspaces={() => { setEditorAssistant(undefined); setPanel("workspaces"); }}
            onOpenMarketplace={() => { setEditorAssistant(undefined); setPanel("marketplace"); }}
            onSaved={(assistant) => {
              setAssistants((current) => [assistant, ...current.filter((item) => item.id !== assistant.id)]);
              if (selectedAssistant?.id === assistant.id || !selectedAssistant) setSelectedAssistant(assistant);
              setEditorAssistant(undefined);
              setNotice("助手已保存");
            }}
          />
        </Suspense>
      )}
      {modelsOpen && (
        <Suspense fallback={<div className="wuxianpi-state">正在加载模型设置…</div>}>
          <ModelsConfig onClose={closeModelsPage} onModelsChanged={() => void loadPlatform()} />
        </Suspense>
      )}
      {notice && <div className="wuxianpi-toast" role="status">{notice}</div>}
    </main>
  );
}

function ConversationDrawer({
  assistants,
  grouped,
  activeSessionId,
  onOpen,
  onNew,
}: {
  assistants: AssistantSummary[];
  grouped: { map: Map<string, SessionInfo[]>; unbound: SessionInfo[]; unavailable: SessionInfo[] };
  activeSessionId: string | null;
  onOpen: (session: SessionInfo) => void;
  onNew: (assistant: AssistantSummary) => void;
}) {
  const groups = assistants
    .map((assistant) => ({ assistant, sessions: grouped.map.get(assistant.id) ?? [] }))
    .filter((group) => group.sessions.length > 0 || !group.assistant.manifest.archived)
    .sort((a, b) => {
      const aTime = a.sessions[0]?.modified ?? a.assistant.lastActiveAt ?? "";
      const bTime = b.sessions[0]?.modified ?? b.assistant.lastActiveAt ?? "";
      if (a.assistant.id === DEFAULT_ASSISTANT_ID && !aTime && b.assistant.id !== DEFAULT_ASSISTANT_ID) return -1;
      if (b.assistant.id === DEFAULT_ASSISTANT_ID && !bTime && a.assistant.id !== DEFAULT_ASSISTANT_ID) return 1;
      return bTime.localeCompare(aTime);
    });

  if (groups.every((group) => group.sessions.length === 0) && grouped.unbound.length === 0 && grouped.unavailable.length === 0) {
    return (
      <div className="empty-hero shell-drawer-empty">
        <div>◌</div>
        <h2>还没有对话</h2>
        <p>点上方「新对话」开始，或在助手库中选择角色。</p>
      </div>
    );
  }

  return (
    <div className="conversation-groups shell-conversation-groups">
      {groups.map(({ assistant, sessions: items }) => (
        <section key={assistant.id}>
          <header>
            <div className="assistant-mini-avatar"><AssistantAvatarVisual assistant={assistant} /></div>
            <div>
              <strong>{assistant.manifest.name}</strong>
              <small>{items.length} 个对话</small>
            </div>
            <button type="button" onClick={() => onNew(assistant)}>新对话</button>
          </header>
          <div>
            {items.length === 0 && <p className="shell-group-empty">暂无历史，点「新对话」开始</p>}
            {items.map((session) => (
              <ConversationRow
                key={session.id}
                session={session}
                active={session.id === activeSessionId}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ))}
      {grouped.unbound.length > 0 && (
        <section>
          <header>
            <div className="assistant-mini-avatar muted">P</div>
            <div>
              <strong>未归属 Pi 会话</strong>
              <small>{grouped.unbound.length} 个对话 · 只能继续原会话</small>
            </div>
          </header>
          <div>
            {grouped.unbound.map((session) => (
              <ConversationRow key={session.id} session={session} active={session.id === activeSessionId} onOpen={onOpen} />
            ))}
          </div>
        </section>
      )}
      {grouped.unavailable.length > 0 && (
        <section>
          <header>
            <div className="assistant-mini-avatar muted">!</div>
            <div><strong>助手不可用</strong><small>{grouped.unavailable.length} 个历史对话</small></div>
          </header>
          <div>{grouped.unavailable.map((session) => <ConversationRow key={session.id} session={session} active={session.id === activeSessionId} onOpen={onOpen} />)}</div>
        </section>
      )}
    </div>
  );
}

function ConversationRow({ session, active, onOpen }: { session: SessionInfo; active?: boolean; onOpen: (session: SessionInfo) => void }) {
  const scope = session.workspaceName
    ?? (session.workspaceId ? basename(session.cwd) || "工作区" : session.ownershipState === "unbound" ? basename(session.cwd) || "Pi 会话" : "日常对话");
  return (
    <button type="button" className={`conversation-row ${active ? "active" : ""}`} onClick={() => onOpen(session)}>
      <span>
        <strong>{session.name || session.firstMessage || "新对话"}</strong>
        <small>{scope} · {session.messageCount} 条消息</small>
      </span>
      <time>{formatTime(session.modified)}</time>
      <em>›</em>
    </button>
  );
}

function AssistantsPanel({
  loading,
  error,
  platformUnavailable,
  visibleAssistants,
  search,
  setSearch,
  onRetry,
  onCreate,
  onImport,
  onOpenChat,
  onEdit,
  onClone,
  onExport,
  onArchive,
}: {
  loading: boolean;
  error: string | null;
  platformUnavailable: boolean;
  visibleAssistants: AssistantSummary[];
  search: string;
  setSearch: (value: string) => void;
  onRetry: () => void;
  onCreate: () => void;
  onImport: () => void;
  onOpenChat: (assistant: AssistantSummary, prompt?: string) => void;
  onEdit: (assistant: AssistantSummary) => void;
  onClone: (assistant: AssistantSummary) => void;
  onExport: (assistant: AssistantSummary) => void;
  onArchive: (assistant: AssistantSummary) => void;
}) {
  return (
    <div className="wuxianpi-page assistants-page">
      <header className="wuxianpi-page-header home-header">
        <div>
          <span className="brand-mark">∞π</span>
          <h1>助手库</h1>
          <p>管理角色目录；主屏始终是对话。</p>
        </div>
        <button type="button" className="round-add" onClick={onCreate} disabled={platformUnavailable} aria-label="创建助手">＋</button>
      </header>
      <div className="assistant-toolbar">
        <label className="search-box">
          <span>⌕</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索助手" />
        </label>
        <button type="button" className="secondary-button compact" onClick={onImport} disabled={platformUnavailable}>导入</button>
      </div>
      {platformUnavailable && (
        <div className="wuxianpi-state warning">
          <span>助手服务当前不可用。已有 Pi 会话仍可从对话列表打开，但不能创建新的未归属会话。</span>
        </div>
      )}
      {loading && <AssistantSkeleton />}
      {error && (
        <div className="wuxianpi-state error">
          <span>{error}</span>
          <button type="button" onClick={onRetry}>重试</button>
        </div>
      )}
      {!loading && !error && visibleAssistants.length === 0 && (
        <div className="empty-hero">
          <div>∞</div>
          <h2>创建你的第一个助手</h2>
          <p>角色、记忆、知识和 Skills 都保存在它自己的目录中。</p>
          <button type="button" className="primary-button" disabled={platformUnavailable} onClick={onCreate}>创建助手</button>
        </div>
      )}
      <div className="assistant-grid">
        {visibleAssistants.map((assistant) => (
          <article key={assistant.id} className={`assistant-card ${assistant.manifest.archived ? "archived" : ""}`}>
            <button type="button" className="assistant-card-main" onClick={() => onOpenChat(assistant)}>
              <span className="assistant-avatar">
                <AssistantAvatarVisual assistant={assistant} />
              </span>
              <span className="assistant-card-copy">
                <strong>{assistant.manifest.name}</strong>
                <small>{assistant.manifest.description || "私人助手"}</small>
                <em>{assistant.sessionCount} 个对话 · {formatTime(assistant.lastActiveAt)}</em>
              </span>
              <span className="assistant-card-arrow">›</span>
            </button>
            {(assistant.manifest.starterPrompts ?? []).length > 0 && (
              <div className="starter-chip-row">
                {assistant.manifest.starterPrompts?.slice(0, 3).map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => onOpenChat(assistant, resolveStarterPrompt(prompt, assistant.id === "wuxianpi").prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
            <div className="assistant-card-actions">
              <button type="button" onClick={() => onEdit(assistant)}>编辑</button>
              <button type="button" onClick={() => onClone(assistant)}>复制</button>
              <button type="button" onClick={() => onExport(assistant)}>导出</button>
              <button type="button" onClick={() => onArchive(assistant)}>{assistant.manifest.archived ? "恢复" : "归档"}</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function AssistantSkeleton() {
  return (
    <div className="assistant-grid">
      {[0, 1, 2].map((item) => (
        <div key={item} className="assistant-card skeleton">
          <span />
          <div><i /><i /><i /></div>
        </div>
      ))}
    </div>
  );
}

function SettingsPage({
  isDark,
  toggleTheme,
  includeArchived,
  setIncludeArchived,
  platformUnavailable,
  onOpenModels,
}: {
  isDark: boolean;
  toggleTheme: () => void;
  includeArchived: boolean;
  setIncludeArchived: (value: boolean) => void;
  platformUnavailable: boolean;
  onOpenModels: () => void;
}) {
  return (
    <div className="wuxianpi-page settings-page">
      <header className="wuxianpi-page-header">
        <div>
          <span className="eyebrow">SETTINGS</span>
          <h1>设置</h1>
          <p>WuxianPi 运行在 Termux；Pi Runtime 保持原样。</p>
        </div>
      </header>
      <div className="settings-stack">
        <section className="settings-card list">
          <button type="button" onClick={onOpenModels}>
            <span><strong>模型服务</strong><small>Provider、API Key 与默认模型</small></span>
            <em>›</em>
          </button>
          <label>
            <span><strong>深色模式</strong><small>跟随你的阅读环境</small></span>
            <input type="checkbox" checked={isDark} onChange={toggleTheme} />
          </label>
          <label>
            <span><strong>显示已归档助手</strong><small>在助手库中显示归档卡片</small></span>
            <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
          </label>
        </section>
        <section className="settings-card">
          <header>
            <div>
              <strong>运行信息</strong>
              <small>WuxianPi v{import.meta.env.VITE_APP_VERSION ?? "0.1.0"} · Pi v{import.meta.env.VITE_PI_VERSION ?? "unknown"}</small>
            </div>
            <span className={`status-pill ${platformUnavailable ? "warning" : "success"}`}>
              {platformUnavailable ? "助手服务不可用" : "能力层在线"}
            </span>
          </header>
        </section>
      </div>
    </div>
  );
}
