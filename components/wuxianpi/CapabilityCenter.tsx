"use client";

import { useMemo, useState } from "react";
import type {
  CapabilityCatalog,
  GlobalWuxianPiConfigV1,
  McpServerConfig,
  TtsProfile,
  WebExtensionSummary,
} from "@/lib/wuxianpi/contracts";
import { WUXIANPI_SCHEMA_VERSION } from "@/lib/wuxianpi/contracts";
import { updateGlobalConfig } from "./api";
import { ExtensionHost } from "./ExtensionHost";

type Tab = "overview" | "mcp" | "tts" | "extensions" | "runtime";

interface Props {
  catalog: CapabilityCatalog | null;
  config: GlobalWuxianPiConfigV1 | null;
  extensions: WebExtensionSummary[];
  loading?: boolean;
  error?: string | null;
  onReload: () => void;
  onConfigChanged: (config: GlobalWuxianPiConfigV1) => void;
  onOpenModels: () => void;
  hostAssistantId?: string;
}

function emptyConfig(): GlobalWuxianPiConfigV1 {
  return {
    schemaVersion: WUXIANPI_SCHEMA_VERSION,
    defaults: { maxLiveSessions: 2, idleSessionMs: 120_000 },
    mcpServers: [],
    ttsProfiles: [],
    permissions: [],
    ubuntu: { enabled: false, distro: "ubuntu", idleTimeoutMs: 300_000 },
  };
}

function newMcp(index: number): McpServerConfig {
  return { id: `mcp-${index + 1}`, name: `MCP ${index + 1}`, transport: "stdio", runtime: "termux", command: "", args: [], enabled: true };
}

function newTts(index: number): TtsProfile {
  return { id: `voice-${index + 1}`, name: `声音 ${index + 1}`, provider: "browser-speech", rate: 1, pitch: 1, enabled: true };
}

export function CapabilityCenter({ catalog, config, extensions, loading, error, onReload, onConfigChanged, onOpenModels, hostAssistantId }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [draft, setDraft] = useState<GlobalWuxianPiConfigV1>(() => config ?? emptyConfig());
  const [sourceConfig, setSourceConfig] = useState(config);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<{ extension: WebExtensionSummary; id: string; title: string; entry: string } | null>(null);

  if (config !== sourceConfig) {
    setSourceConfig(config);
    if (config) setDraft(config);
  }

  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const capability of catalog?.capabilities ?? []) result.set(capability.source, (result.get(capability.source) ?? 0) + 1);
    return result;
  }, [catalog]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await updateGlobalConfig(draft);
      setDraft(next);
      onConfigChanged(next);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="wuxianpi-page capability-center-page">
      <header className="wuxianpi-page-header">
        <div><span className="eyebrow">CAPABILITY CENTER</span><h1>能力中心</h1><p>全局注册能力，助手按需引用。密钥不会写入助手目录。</p></div>
        <button type="button" className="secondary-button" onClick={onReload}>刷新</button>
      </header>
      <nav className="wuxianpi-segmented capability-tabs">
        {(["overview", "mcp", "tts", "extensions", "runtime"] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item === "overview" ? "总览" : item === "mcp" ? "MCP" : item === "tts" ? "语音" : item === "extensions" ? "WebUI" : "运行时"}
          </button>
        ))}
      </nav>
      {loading && <div className="wuxianpi-state">正在发现 Pi、MCP、TTS 与扩展能力…</div>}
      {(error || saveError) && <div className="wuxianpi-state error"><span>{saveError ?? error}</span><button onClick={onReload}>重试</button></div>}
      {!loading && tab === "overview" && (
        <div className="capability-overview-grid">
          <button type="button" className="capability-summary-card accent" onClick={onOpenModels}><span>模型</span><strong>全局配置</strong><small>Provider、API Key、默认模型</small></button>
          {[...counts.entries()].map(([source, count]) => <article key={source} className="capability-summary-card"><span>{source}</span><strong>{count}</strong><small>已发现能力</small></article>)}
          <article className="capability-summary-card"><span>诊断</span><strong>{catalog?.diagnostics.filter((item) => item.level === "error").length ?? 0}</strong><small>需要处理的问题</small></article>
        </div>
      )}
      {!loading && tab === "mcp" && (
        <div className="settings-stack">
          {draft.mcpServers.map((server, index) => (
            <section key={`${server.id}-${index}`} className="settings-card">
              <header><div><strong>{server.name || server.id}</strong><small>{server.transport} · {server.runtime ?? "termux"}</small></div><button type="button" className="danger-link" onClick={() => setDraft((current) => ({ ...current, mcpServers: current.mcpServers.filter((_, i) => i !== index) }))}>移除</button></header>
              <div className="form-grid compact">
                <label>ID<input value={server.id} onChange={(event) => setDraft((current) => ({ ...current, mcpServers: current.mcpServers.map((item, i) => i === index ? { ...item, id: event.target.value } : item) }))} /></label>
                <label>名称<input value={server.name} onChange={(event) => setDraft((current) => ({ ...current, mcpServers: current.mcpServers.map((item, i) => i === index ? { ...item, name: event.target.value } : item) }))} /></label>
                <label>传输<select value={server.transport} onChange={(event) => setDraft((current) => ({ ...current, mcpServers: current.mcpServers.map((item, i) => i === index ? { ...item, transport: event.target.value as McpServerConfig["transport"] } : item) }))}><option value="stdio">stdio</option><option value="streamable-http">streamable-http</option></select></label>
                <label>运行位置<select value={server.runtime ?? "termux"} onChange={(event) => setDraft((current) => ({ ...current, mcpServers: current.mcpServers.map((item, i) => i === index ? { ...item, runtime: event.target.value as McpServerConfig["runtime"] } : item) }))}><option value="termux">Termux</option><option value="ubuntu">Ubuntu Worker</option></select></label>
                {server.transport === "stdio" ? <><label className="span-2">命令<input value={server.command ?? ""} onChange={(event) => setDraft((current) => ({ ...current, mcpServers: current.mcpServers.map((item, i) => i === index ? { ...item, command: event.target.value } : item) }))} placeholder="npx -y …" /></label><label className="span-2">参数（每行一个）<textarea rows={3} value={(server.args ?? []).join("\n")} onChange={(event) => setDraft((current) => ({ ...current, mcpServers: current.mcpServers.map((item, i) => i === index ? { ...item, args: event.target.value.split("\n").filter(Boolean) } : item) }))} /></label></> : <label className="span-2">URL<input value={server.url ?? ""} onChange={(event) => setDraft((current) => ({ ...current, mcpServers: current.mcpServers.map((item, i) => i === index ? { ...item, url: event.target.value } : item) }))} /></label>}
                <label className="check-row"><input type="checkbox" checked={server.enabled !== false} onChange={(event) => setDraft((current) => ({ ...current, mcpServers: current.mcpServers.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item) }))} />启用</label>
              </div>
            </section>
          ))}
          <button type="button" className="add-card-button" onClick={() => setDraft((current) => ({ ...current, mcpServers: [...current.mcpServers, newMcp(current.mcpServers.length)] }))}>＋ 添加 MCP 服务</button>
        </div>
      )}
      {!loading && tab === "tts" && (
        <div className="settings-stack">
          {draft.ttsProfiles.map((profile, index) => (
            <section key={`${profile.id}-${index}`} className="settings-card"><header><div><strong>{profile.name}</strong><small>{profile.provider}</small></div><button type="button" className="danger-link" onClick={() => setDraft((current) => ({ ...current, ttsProfiles: current.ttsProfiles.filter((_, i) => i !== index) }))}>移除</button></header>
              <div className="form-grid compact">
                <label>ID<input value={profile.id} onChange={(event) => setDraft((current) => ({ ...current, ttsProfiles: current.ttsProfiles.map((item, i) => i === index ? { ...item, id: event.target.value } : item) }))} /></label>
                <label>名称<input value={profile.name} onChange={(event) => setDraft((current) => ({ ...current, ttsProfiles: current.ttsProfiles.map((item, i) => i === index ? { ...item, name: event.target.value } : item) }))} /></label>
                <label>Provider<select value={profile.provider} onChange={(event) => setDraft((current) => ({ ...current, ttsProfiles: current.ttsProfiles.map((item, i) => i === index ? { ...item, provider: event.target.value as TtsProfile["provider"] } : item) }))}><option value="browser-speech">浏览器语音</option><option value="termux-api">Termux API</option><option value="openai-compatible">OpenAI-compatible</option><option value="http">HTTP</option></select></label>
                <label>Voice<input value={profile.voice ?? ""} onChange={(event) => setDraft((current) => ({ ...current, ttsProfiles: current.ttsProfiles.map((item, i) => i === index ? { ...item, voice: event.target.value } : item) }))} /></label>
                {profile.provider !== "browser-speech" && profile.provider !== "termux-api" && <label className="span-2">Base URL<input value={profile.baseUrl ?? ""} onChange={(event) => setDraft((current) => ({ ...current, ttsProfiles: current.ttsProfiles.map((item, i) => i === index ? { ...item, baseUrl: event.target.value } : item) }))} /></label>}
                <label className="check-row"><input type="checkbox" checked={profile.enabled !== false} onChange={(event) => setDraft((current) => ({ ...current, ttsProfiles: current.ttsProfiles.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item) }))} />启用</label>
              </div>
            </section>
          ))}
          <button type="button" className="add-card-button" onClick={() => setDraft((current) => ({ ...current, ttsProfiles: [...current.ttsProfiles, newTts(current.ttsProfiles.length)] }))}>＋ 添加声音</button>
        </div>
      )}
      {!loading && tab === "extensions" && (
        <div className="extension-grid">
          {extensions.length === 0 && <div className="wuxianpi-state">暂无 WebUI 扩展。把扩展安装到全局扩展目录后刷新即可发现。</div>}
          {extensions.map((extension) => (
            <article key={extension.id} className="extension-card"><div className="extension-card-icon">⌁</div><div><strong>{extension.manifest.name}</strong><small>{extension.manifest.description ?? extension.id}</small><span>v{extension.manifest.version} · {extension.enabled ? "已启用" : "已停用"}</span></div>
              <div className="extension-card-actions">{extension.manifest.contributes?.settingsPanels?.map((panel) => <button key={panel.id} disabled={!hostAssistantId} title={!hostAssistantId ? "先创建并启用此扩展的助手" : undefined} onClick={() => setOpenPanel({ extension, ...panel })}>{panel.title}</button>)}{extension.manifest.contributes?.fullPages?.map((page) => <button key={page.id} disabled={!hostAssistantId} title={!hostAssistantId ? "先创建并启用此扩展的助手" : undefined} onClick={() => setOpenPanel({ extension, ...page })}>{page.title}</button>)}</div>
            </article>
          ))}
        </div>
      )}
      {!loading && tab === "runtime" && (
        <div className="settings-stack"><section className="settings-card"><header><div><strong>Termux 原生运行时</strong><small>WuxianPi、Pi Runtime、普通工具和 Android Bridge</small></div><span className="status-pill success">默认</span></header></section>
          <section className="settings-card"><header><div><strong>Ubuntu Tool Worker</strong><small>只为 glibc、Chromium、重型 Python 等按需启动</small></div><label className="switch"><input type="checkbox" checked={draft.ubuntu?.enabled ?? false} onChange={(event) => setDraft((current) => ({ ...current, ubuntu: { ...current.ubuntu, enabled: event.target.checked } }))} /><span /></label></header>
            <div className="form-grid compact"><label>发行版<input value={draft.ubuntu?.distro ?? "ubuntu"} onChange={(event) => setDraft((current) => ({ ...current, ubuntu: { enabled: current.ubuntu?.enabled ?? false, ...current.ubuntu, distro: event.target.value } }))} /></label><label>空闲退出（毫秒）<input type="number" value={draft.ubuntu?.idleTimeoutMs ?? 300000} onChange={(event) => setDraft((current) => ({ ...current, ubuntu: { enabled: current.ubuntu?.enabled ?? false, ...current.ubuntu, idleTimeoutMs: Number(event.target.value) } }))} /></label></div>
          </section>
          <section className="settings-card"><header><div><strong>移动端会话缓存</strong><small>限制同时存活的 AgentSession，降低内存占用</small></div></header><div className="form-grid compact"><label>最大活动会话<input type="number" min="1" max="8" value={draft.defaults.maxLiveSessions ?? 2} onChange={(event) => setDraft((current) => ({ ...current, defaults: { ...current.defaults, maxLiveSessions: Number(event.target.value) } }))} /></label><label>空闲回收（毫秒）<input type="number" value={draft.defaults.idleSessionMs ?? 120000} onChange={(event) => setDraft((current) => ({ ...current, defaults: { ...current.defaults, idleSessionMs: Number(event.target.value) } }))} /></label></div></section>
        </div>
      )}
      {(tab === "mcp" || tab === "tts" || tab === "runtime") && <div className="sticky-save-bar"><span>{saveError ?? "更改会应用到新会话；运行中的会话保持当前配置。"}</span><button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存全局配置"}</button></div>}
      {openPanel && <div className="wuxianpi-modal-backdrop"><div className="extension-modal"><ExtensionHost extension={openPanel.extension} entry={openPanel.entry} assistantId={hostAssistantId} title={openPanel.title} onClose={() => setOpenPanel(null)} fallback={<p>可继续使用扩展的通用工具能力。</p>} /></div></div>}
    </div>
  );
}
