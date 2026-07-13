"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import type { AssistantSummary, CapabilityCatalog, GlobalWuxianPiConfigV1, WebExtensionSummary } from "@/lib/wuxianpi/contracts";
import { WUXIANPI_SCHEMA_VERSION } from "@/lib/wuxianpi/contracts";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import { useTheme } from "@/hooks/useTheme";
import { ChatWindow } from "./ChatWindow";
import type { ChatInputHandle } from "./ChatInput";
import {
  cloneAssistant,
  exportAssistant,
  getCapabilityCatalog,
  getGlobalConfig,
  importAssistant,
  isUnavailableError,
  listAssistants,
  listWebExtensions,
  setAssistantArchived,
} from "./wuxianpi/api";

const ModelsConfig = dynamic(() => import("./ModelsConfig").then((module) => module.ModelsConfig), { ssr: false, loading: () => <div className="wuxianpi-state">正在加载模型设置…</div> });
const AssistantEditor = dynamic(() => import("./wuxianpi/AssistantEditor").then((module) => module.AssistantEditor), { ssr: false, loading: () => <div className="wuxianpi-modal-backdrop"><div className="wuxianpi-state">正在加载助手编辑器…</div></div> });
const CapabilityCenter = dynamic(() => import("./wuxianpi/CapabilityCenter").then((module) => module.CapabilityCenter), { ssr: false, loading: () => <div className="wuxianpi-state">正在加载能力中心…</div> });
const BranchNavigator = dynamic(() => import("./BranchNavigator").then((module) => module.BranchNavigator), { ssr: false });

type MainView = "assistants" | "chats" | "capabilities" | "settings";

function avatarText(assistant: AssistantSummary): string {
  return assistant.manifest.name.trim().slice(0, 1).toUpperCase() || "π";
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

function virtualAssistant(cwd: string, sessions: SessionInfo[]): AssistantSummary {
  const encoded = encodeURIComponent(cwd).replace(/%/g, "").slice(-40) || "default";
  const latest = [...sessions].sort((a, b) => b.modified.localeCompare(a.modified))[0];
  return {
    id: `legacy-${encoded}`,
    path: cwd,
    manifest: {
      schemaVersion: WUXIANPI_SCHEMA_VERSION,
      name: basename(cwd) || "通用助手",
      description: "旧版工作区会话（兼容模式）",
      model: "inherit",
      tools: "inherit",
    },
    sessionCount: sessions.length,
    lastActiveAt: latest?.modified,
    diagnostics: [{ level: "info", code: "LEGACY_WORKSPACE", message: "该工作区尚未转换为助手目录" }],
  };
}

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isDark, toggleTheme } = useTheme();
  const [view, setView] = useState<MainView>("assistants");
  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [extensions, setExtensions] = useState<WebExtensionSummary[]>([]);
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [globalConfig, setGlobalConfig] = useState<GlobalWuxianPiConfigV1 | null>(null);
  const [selectedAssistant, setSelectedAssistant] = useState<AssistantSummary | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);
  const [editorAssistant, setEditorAssistant] = useState<AssistantSummary | null | undefined>(undefined);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [platformUnavailable, setPlatformUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const importRef = useRef<HTMLInputElement | null>(null);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeRef = useRef<((leafId: string | null) => void) | null>(null);

  const loadSessions = useCallback(async () => {
    const response = await fetch("/api/sessions");
    if (!response.ok) throw new Error(`无法读取历史对话（HTTP ${response.status}）`);
    const data = await response.json() as { sessions?: SessionInfo[] };
    setSessions(data.sessions ?? []);
    return data.sessions ?? [];
  }, []);

  const loadPlatform = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loadedSessions = await loadSessions();
      try {
        const [assistantList, capabilityCatalog, config, extensionList] = await Promise.all([
          listAssistants({ includeArchived: true }),
          getCapabilityCatalog(),
          getGlobalConfig(),
          listWebExtensions(),
        ]);
        setAssistants(assistantList);
        setCatalog(capabilityCatalog);
        setGlobalConfig(config);
        setExtensions(extensionList);
        setPlatformUnavailable(false);
      } catch (reason) {
        if (!isUnavailableError(reason)) throw reason;
        const byCwd = new Map<string, SessionInfo[]>();
        for (const session of loadedSessions) byCwd.set(session.cwd, [...(byCwd.get(session.cwd) ?? []), session]);
        setAssistants([...byCwd.entries()].map(([cwd, items]) => virtualAssistant(cwd, items)));
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
    if (!sessions.length || chatOpen) return;
    const requested = searchParams.get("session");
    if (!requested) return;
    const target = sessions.find((session) => session.id === requested);
    if (!target) return;
    const owner = assistants.find((assistant) => assistant.path === target.cwd) ?? virtualAssistant(target.cwd, sessions.filter((session) => session.cwd === target.cwd));
    setSelectedAssistant(owner);
    setSelectedSession(target);
    setChatOpen(true);
  }, [assistants, chatOpen, searchParams, sessions]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const sessionsByAssistant = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const assistant of assistants) map.set(assistant.id, []);
    const legacy: SessionInfo[] = [];
    for (const session of sessions) {
      const owner = assistants.find((assistant) => assistant.path === session.cwd);
      if (owner) map.get(owner.id)?.push(session);
      else legacy.push(session);
    }
    for (const items of map.values()) items.sort((a, b) => b.modified.localeCompare(a.modified));
    legacy.sort((a, b) => b.modified.localeCompare(a.modified));
    return { map, legacy };
  }, [assistants, sessions]);

  const visibleAssistants = useMemo(() => assistants
    .filter((assistant) => includeArchived || !assistant.manifest.archived)
    .filter((assistant) => !search || `${assistant.manifest.name} ${assistant.manifest.description ?? ""}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "")), [assistants, includeArchived, search]);

  const openNewChat = (assistant: AssistantSummary, prompt?: string) => {
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSelectedAssistant(assistant);
    setSelectedSession(null);
    setInitialPrompt(prompt ?? null);
    setChatKey((key) => key + 1);
    setChatOpen(true);
    router.replace("/");
  };

  const openSession = (session: SessionInfo) => {
    setBranchTree([]);
    setBranchActiveLeafId(null);
    const owner = assistants.find((assistant) => assistant.path === session.cwd) ?? virtualAssistant(session.cwd, sessions.filter((item) => item.cwd === session.cwd));
    setSelectedAssistant(owner);
    setSelectedSession(session);
    setInitialPrompt(null);
    setChatKey((key) => key + 1);
    setChatOpen(true);
    router.replace(`/?session=${encodeURIComponent(session.id)}`);
  };

  const closeChat = () => {
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setChatOpen(false);
    setSelectedSession(null);
    setInitialPrompt(null);
    router.replace("/");
    void loadSessions();
  };

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

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeRef.current = onLeafChange;
  }, []);

  if (chatOpen && selectedAssistant) {
    return (
      <main className="wuxianpi-app chat-mode">
        <header className="mobile-chat-header">
          <button className="icon-button" type="button" onClick={closeChat} aria-label="返回">‹</button>
          <div className="assistant-mini-avatar">{selectedAssistant.manifest.avatar ? <span style={{ backgroundImage: `url(${selectedAssistant.manifest.avatar})` }} /> : avatarText(selectedAssistant)}</div>
          <div className="mobile-chat-title"><strong>{selectedAssistant.manifest.name}</strong><small>{selectedSession?.name || selectedAssistant.manifest.description || "WuxianPi 助手"}</small></div>
          <button className="icon-button" type="button" onClick={() => setEditorAssistant(selectedAssistant.id.startsWith("legacy-") ? undefined : selectedAssistant)} disabled={selectedAssistant.id.startsWith("legacy-")} aria-label="助手设置">⋯</button>
        </header>
        {selectedSession && <BranchNavigator tree={branchTree} activeLeafId={branchActiveLeafId} onLeafChange={(leafId) => branchLeafChangeRef.current?.(leafId)} hasSession />}
        <div className="mobile-chat-body">
          <ChatWindow
            key={chatKey}
            session={selectedSession}
            newSessionCwd={selectedSession ? null : selectedAssistant.path}
            assistantId={selectedAssistant.id.startsWith("legacy-") ? undefined : selectedAssistant.id}
            assistant={selectedAssistant}
            webExtensions={selectedExtensions}
            defaultTts={globalConfig?.defaults.tts}
            onAgentEnd={() => void loadSessions()}
            onSessionCreated={(session) => { setSelectedSession(session); router.replace(`/?session=${encodeURIComponent(session.id)}`); void loadSessions(); }}
            onSessionForked={(id) => { void loadSessions().then((items) => { const target = items.find((item) => item.id === id); if (target) openSession(target); }); }}
            chatInputRef={chatInputRef}
            initialPrompt={initialPrompt}
            initialPromptKey={initialPrompt ? `${selectedAssistant.id}:${initialPrompt}` : null}
            onInitialPromptQueued={() => setInitialPrompt(null)}
            onOpenModelsConfig={() => setModelsOpen(true)}
            onBranchDataChange={handleBranchDataChange}
          />
        </div>
        {editorAssistant !== undefined && <AssistantEditor assistant={editorAssistant} catalog={catalog} config={globalConfig} onClose={() => setEditorAssistant(undefined)} onSaved={(assistant) => { setAssistants((current) => current.map((item) => item.id === assistant.id ? assistant : item)); setSelectedAssistant(assistant); setEditorAssistant(undefined); }} />}
        {modelsOpen && <ModelsConfig onClose={() => setModelsOpen(false)} />}
      </main>
    );
  }

  return (
    <main className="wuxianpi-app">
      <div className="wuxianpi-content">
        {view === "assistants" && (
          <div className="wuxianpi-page assistants-page">
            <header className="wuxianpi-page-header home-header"><div><span className="brand-mark">∞π</span><h1>WuxianPi</h1><p>你的本地角色助手</p></div><button type="button" className="round-add" onClick={() => setEditorAssistant(null)} disabled={platformUnavailable} aria-label="创建助手">＋</button></header>
            <div className="assistant-toolbar"><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索助手" /></label><button type="button" className="secondary-button compact" onClick={() => importRef.current?.click()} disabled={platformUnavailable}>导入</button><input ref={importRef} hidden type="file" accept="application/zip,.zip,.wuxianpi" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImport(file); event.target.value = ""; }} /></div>
            {platformUnavailable && <div className="wuxianpi-state warning"><span>助手 API 尚未启用，当前以兼容模式展示旧工作区。聊天仍然可用。</span></div>}
            {loading && <AssistantSkeleton />}
            {error && <div className="wuxianpi-state error"><span>{error}</span><button onClick={() => void loadPlatform()}>重试</button></div>}
            {!loading && !error && visibleAssistants.length === 0 && <div className="empty-hero"><div>∞</div><h2>创建你的第一个助手</h2><p>角色、记忆、知识和 Skills 都保存在它自己的目录中。</p><button className="primary-button" disabled={platformUnavailable} onClick={() => setEditorAssistant(null)}>创建助手</button></div>}
            <div className="assistant-grid">
              {visibleAssistants.map((assistant) => (
                <article key={assistant.id} className={`assistant-card ${assistant.manifest.archived ? "archived" : ""}`}>
                  <button type="button" className="assistant-card-main" onClick={() => openNewChat(assistant)}>
                    <span className="assistant-avatar">{assistant.manifest.avatar ? <span style={{ backgroundImage: `url(${assistant.manifest.avatar})` }} /> : avatarText(assistant)}</span>
                    <span className="assistant-card-copy"><strong>{assistant.manifest.name}</strong><small>{assistant.manifest.description || "私人助手"}</small><em>{assistant.sessionCount} 个对话 · {formatTime(assistant.lastActiveAt)}</em></span><span className="assistant-card-arrow">›</span>
                  </button>
                  {(assistant.manifest.starterPrompts ?? []).length > 0 && <div className="starter-chip-row">{assistant.manifest.starterPrompts?.slice(0, 3).map((prompt) => <button key={prompt} onClick={() => openNewChat(assistant, prompt)}>{prompt}</button>)}</div>}
                  {!assistant.id.startsWith("legacy-") && <div className="assistant-card-actions"><button onClick={() => setEditorAssistant(assistant)}>编辑</button><button onClick={() => void handleClone(assistant)}>复制</button><button onClick={() => void exportAssistant(assistant.id).catch((reason) => setNotice(String(reason)))}>导出</button><button onClick={() => void handleArchive(assistant)}>{assistant.manifest.archived ? "恢复" : "归档"}</button></div>}
                </article>
              ))}
            </div>
          </div>
        )}
        {view === "chats" && <ChatsPage assistants={assistants} grouped={sessionsByAssistant} onOpen={openSession} onNew={openNewChat} />}
        {view === "capabilities" && <CapabilityCenter catalog={catalog} config={globalConfig} extensions={extensions} hostAssistantId={assistants.find((assistant) => !assistant.id.startsWith("legacy-") && !assistant.manifest.archived)?.id} loading={loading} error={error} onReload={() => void loadPlatform()} onConfigChanged={setGlobalConfig} onOpenModels={() => setModelsOpen(true)} />}
        {view === "settings" && <SettingsPage isDark={isDark} toggleTheme={toggleTheme} includeArchived={includeArchived} setIncludeArchived={setIncludeArchived} platformUnavailable={platformUnavailable} onOpenModels={() => setModelsOpen(true)} />}
      </div>
      <nav className="mobile-bottom-nav" aria-label="主导航">
        <NavButton active={view === "assistants"} icon="∞" label="助手" onClick={() => setView("assistants")} />
        <NavButton active={view === "chats"} icon="◌" label="对话" onClick={() => setView("chats")} />
        <NavButton active={view === "capabilities"} icon="⌁" label="能力" onClick={() => setView("capabilities")} />
        <NavButton active={view === "settings"} icon="⚙" label="设置" onClick={() => setView("settings")} />
      </nav>
      {editorAssistant !== undefined && <AssistantEditor assistant={editorAssistant} catalog={catalog} config={globalConfig} onClose={() => setEditorAssistant(undefined)} onSaved={(assistant) => { setAssistants((current) => [assistant, ...current.filter((item) => item.id !== assistant.id)]); setEditorAssistant(undefined); setNotice("助手已保存"); }} />}
      {modelsOpen && <ModelsConfig onClose={() => setModelsOpen(false)} onModelsChanged={() => void loadPlatform()} />}
      {notice && <div className="wuxianpi-toast" role="status">{notice}</div>}
    </main>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: string; label: string; onClick: () => void }) {
  return <button type="button" className={active ? "active" : ""} onClick={onClick}><span>{icon}</span><small>{label}</small></button>;
}

function AssistantSkeleton() {
  return <div className="assistant-grid">{[0, 1, 2].map((item) => <div key={item} className="assistant-card skeleton"><span /><div><i /><i /><i /></div></div>)}</div>;
}

function ChatsPage({ assistants, grouped, onOpen, onNew }: { assistants: AssistantSummary[]; grouped: { map: Map<string, SessionInfo[]>; legacy: SessionInfo[] }; onOpen: (session: SessionInfo) => void; onNew: (assistant: AssistantSummary) => void }) {
  const groups = assistants.map((assistant) => ({ assistant, sessions: grouped.map.get(assistant.id) ?? [] })).filter((group) => group.sessions.length > 0);
  return <div className="wuxianpi-page chats-page"><header className="wuxianpi-page-header"><div><span className="eyebrow">HISTORY</span><h1>对话</h1><p>历史按助手目录归组；旧项目会话保留在兼容分组。</p></div></header>
    {groups.length === 0 && grouped.legacy.length === 0 && <div className="empty-hero"><div>◌</div><h2>还没有对话</h2><p>从助手首页开始一段新对话。</p></div>}
    <div className="conversation-groups">{groups.map(({ assistant, sessions }) => <section key={assistant.id}><header><div className="assistant-mini-avatar">{avatarText(assistant)}</div><div><strong>{assistant.manifest.name}</strong><small>{sessions.length} 个对话</small></div><button onClick={() => onNew(assistant)}>新对话</button></header><div>{sessions.map((session) => <ConversationRow key={session.id} session={session} onOpen={onOpen} />)}</div></section>)}
      {grouped.legacy.length > 0 && <section><header><div className="assistant-mini-avatar muted">L</div><div><strong>旧版工作区</strong><small>{grouped.legacy.length} 个未归属对话</small></div></header><div>{grouped.legacy.map((session) => <ConversationRow key={session.id} session={session} onOpen={onOpen} />)}</div></section>}
    </div>
  </div>;
}

function ConversationRow({ session, onOpen }: { session: SessionInfo; onOpen: (session: SessionInfo) => void }) {
  return <button className="conversation-row" onClick={() => onOpen(session)}><span><strong>{session.name || session.firstMessage || "新对话"}</strong><small>{basename(session.cwd)} · {session.messageCount} 条消息</small></span><time>{formatTime(session.modified)}</time><em>›</em></button>;
}

function SettingsPage({ isDark, toggleTheme, includeArchived, setIncludeArchived, platformUnavailable, onOpenModels }: { isDark: boolean; toggleTheme: () => void; includeArchived: boolean; setIncludeArchived: (value: boolean) => void; platformUnavailable: boolean; onOpenModels: () => void }) {
  return <div className="wuxianpi-page settings-page"><header className="wuxianpi-page-header"><div><span className="eyebrow">SETTINGS</span><h1>设置</h1><p>WuxianPi 运行在 Termux；Pi Runtime 保持原样。</p></div></header><div className="settings-stack"><section className="settings-card list"><button onClick={onOpenModels}><span><strong>模型服务</strong><small>Provider、API Key 与默认模型</small></span><em>›</em></button><label><span><strong>深色模式</strong><small>跟随你的阅读环境</small></span><input type="checkbox" checked={isDark} onChange={toggleTheme} /></label><label><span><strong>显示已归档助手</strong><small>在助手首页显示归档卡片</small></span><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /></label></section><section className="settings-card"><header><div><strong>运行信息</strong><small>WuxianPi v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0"} · Pi v{process.env.NEXT_PUBLIC_PI_VERSION ?? "unknown"}</small></div><span className={`status-pill ${platformUnavailable ? "warning" : "success"}`}>{platformUnavailable ? "兼容模式" : "能力层在线"}</span></header></section></div></div>;
}
