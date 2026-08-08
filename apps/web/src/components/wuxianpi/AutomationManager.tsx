"use client";

import { useState } from "react";
import { Bot, Check, Clock3, Pause, Play, Plus, ShieldCheck, Square, X } from "lucide-react";
import type {
  AssistantSummary,
  AutomationCreateRequest,
  AutomationRegistration,
  AutomationTarget,
  AutomationUpdateRequest,
  Workspace,
} from "@/lib/wuxianpi/contracts";
import type { SessionInfo } from "@/lib/types";
import { automationAction, createAutomation, updateAutomation } from "./api";

interface Props {
  automations: AutomationRegistration[];
  assistants: AssistantSummary[];
  sessions: SessionInfo[];
  workspaces: Workspace[];
  selectedSessionId?: string | null;
  onChanged: (automations: AutomationRegistration[]) => void;
}

type TargetMode = "existing" | "dedicated" | "per-run";
type Draft = {
  id: string; title: string; reason: string; projectRoot: string; maxCalls: string; windowHours: string;
  expiryDays: string; targetMode: TargetMode; conversationId: string; assistantId: string; workspaceId: string; cwd: string;
};

const EMPTY_DRAFT: Draft = {
  id: "", title: "", reason: "", projectRoot: "", maxCalls: "2", windowHours: "24", expiryDays: "30",
  targetMode: "existing", conversationId: "", assistantId: "", workspaceId: "", cwd: "",
};

function isoAfterDays(days: number): string { return new Date(Date.now() + days * 86_400_000).toISOString(); }
function formatWindow(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  return `${Math.round(seconds / 60)} 分钟`;
}
function formatExpiry(value: string): string {
  const days = Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
  return days > 0 ? `${days} 天后到期` : "已到期";
}
function statusLabel(automation: AutomationRegistration): string {
  if (automation.status === "active" && new Date(automation.expiresAt).getTime() - Date.now() <= 2 * 86_400_000 && automation.rateLimit.maxCalls >= 10) return "调试中";
  return ({ pending: "待确认", active: "已启用", paused: "已暂停", expired: "已到期", revoked: "已停止" } as const)[automation.status];
}
function targetLabel(automation: AutomationRegistration, sessions: SessionInfo[]): string {
  const target = automation.target;
  if (target.kind === "existing") return sessions.find((session) => session.id === target.conversationId)?.name ?? "已有对话";
  return target.mode === "per-run" ? "每次使用时创建新对话" : "启用时创建专用对话";
}

function targetFromDraft(draft: Draft): AutomationTarget {
  if (draft.targetMode === "existing") return { kind: "existing", conversationId: draft.conversationId };
  return {
    kind: "new", mode: draft.targetMode, assistantId: draft.assistantId,
    workspaceId: draft.workspaceId || null, cwd: draft.cwd || null,
  };
}

export function AutomationManager({ automations, assistants, sessions, workspaces, selectedSessionId, onChanged }: Props) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AutomationRegistration | null>(null);
  const [draft, setDraft] = useState<Draft>({ ...EMPTY_DRAFT, conversationId: selectedSessionId ?? sessions[0]?.id ?? "", assistantId: assistants[0]?.id ?? "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const replace = (next: AutomationRegistration) => onChanged([next, ...automations.filter((item) => item.id !== next.id)]);
  const runAction = async (id: string, action: "approve" | "pause" | "resume" | "stop") => {
    setBusy(`${id}:${action}`); setError(null);
    try { replace(await automationAction(id, action)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  };

  const save = async () => {
    setBusy("save"); setError(null);
    try {
      if (creating) {
        const input: AutomationCreateRequest = {
          id: draft.id.trim(), title: draft.title.trim(), reason: draft.reason.trim(), projectRoot: draft.projectRoot.trim(),
          applicantConversationId: selectedSessionId ?? draft.conversationId,
          target: targetFromDraft(draft),
          rateLimit: { maxCalls: Number(draft.maxCalls), windowSeconds: Number(draft.windowHours) * 3_600 },
          expiresAt: isoAfterDays(Number(draft.expiryDays)),
        };
        replace(await createAutomation(input));
      } else if (editing) {
        const input: AutomationUpdateRequest = {
          title: draft.title.trim(), reason: draft.reason.trim(),
          rateLimit: { maxCalls: Number(draft.maxCalls), windowSeconds: Number(draft.windowHours) * 3_600 },
          expiresAt: isoAfterDays(Number(draft.expiryDays)),
        };
        replace(await updateAutomation(editing.id, input));
      }
      setCreating(false); setEditing(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  };

  const startCreate = () => {
    setDraft({ ...EMPTY_DRAFT, conversationId: selectedSessionId ?? sessions[0]?.id ?? "", assistantId: assistants[0]?.id ?? "" });
    setCreating(true); setEditing(null); setError(null);
  };
  const startEdit = (automation: AutomationRegistration) => {
    const days = Math.max(1, Math.ceil((new Date(automation.expiresAt).getTime() - Date.now()) / 86_400_000));
    setDraft({ ...EMPTY_DRAFT, id: automation.id, title: automation.title, reason: automation.reason, projectRoot: automation.projectRoot,
      maxCalls: String(automation.rateLimit.maxCalls), windowHours: String(Math.max(1, Math.round(automation.rateLimit.windowSeconds / 3_600))), expiryDays: String(days) });
    setEditing(automation); setCreating(false); setError(null);
  };

  return <div className="automation-manager wuxianpi-page">
    <header className="wuxianpi-page-header">
      <div><span className="eyebrow">AUTOMATION</span><h1>自动化</h1><p>管理哪些项目可以自动找 AI 帮忙。</p></div>
      <button type="button" className="primary-button" onClick={startCreate}><Plus size={16} />新增自动化</button>
    </header>
    <div className="wuxianpi-state"><ShieldCheck size={17} /><span>自动化只负责允许项目唤醒指定对话，不负责定时和程序运行。</span></div>
    {error && <div className="wuxianpi-state error"><span>{error}</span></div>}
    {(Object.entries({ pending: "待确认", active: "已启用", paused: "已暂停", expired: "已到期", revoked: "已停止" }) as Array<[AutomationRegistration["status"], string]>).map(([status, heading]) => {
      const rows = automations.filter((automation) => automation.status === status);
      if (rows.length === 0) return null;
      return <section className="automation-section" key={status}><header><h2>{heading}</h2><small>{rows.length}</small></header><div className="automation-list">
        {rows.map((automation) => <article className={`automation-row ${automation.status}`} key={automation.id}>
          <div className="automation-row-icon">{automation.status === "pending" ? <Clock3 size={18} /> : <Bot size={18} />}</div>
          <div className="automation-row-main"><div className="automation-row-title"><strong>{automation.title}</strong><span className={`status-pill ${automation.status === "active" ? "success" : "warning"}`}>{statusLabel(automation)}</span></div>
            <p>{automation.reason}</p><small>{formatWindow(automation.rateLimit.windowSeconds)}内最多 {automation.rateLimit.maxCalls} 次 · {formatExpiry(automation.expiresAt)}</small>
          </div>
          <div className="automation-row-meta"><span>{targetLabel(automation, sessions)}</span><small>{automation.rateUsage.used} / {automation.rateLimit.maxCalls} 已接受</small></div>
          <div className="automation-row-actions">
            {automation.status === "pending" && <><button type="button" className="primary-button compact" disabled={busy !== null} onClick={() => void runAction(automation.id, "approve")}><Check size={14} />启用自动化</button><button type="button" className="secondary-button compact" disabled={busy !== null} onClick={() => void runAction(automation.id, "stop")}><X size={14} />拒绝</button></>}
            {automation.status === "active" && <button type="button" className="secondary-button compact" disabled={busy !== null} onClick={() => void runAction(automation.id, "pause")}><Pause size={14} />暂停</button>}
            {automation.status === "paused" && <button type="button" className="secondary-button compact" disabled={busy !== null} onClick={() => void runAction(automation.id, "resume")}><Play size={14} />恢复</button>}
            {(automation.status === "active" || automation.status === "paused") && <button type="button" className="secondary-button compact" disabled={busy !== null} onClick={() => startEdit(automation)}>调整</button>}
            {(automation.status === "active" || automation.status === "paused" || automation.status === "expired") && <button type="button" className="icon-button danger" disabled={busy !== null} onClick={() => void runAction(automation.id, "stop")} aria-label={`停止 ${automation.title}`} title="停止"><Square size={15} /></button>}
          </div>
          <details className="automation-row-details"><summary>查看详情</summary><dl><div><dt>项目</dt><dd>{automation.projectRoot}</dd></div><div><dt>申请来源</dt><dd>{automation.applicantConversationId}</dd></div><div><dt>最近使用</dt><dd>{automation.lastTriggeredAt ? new Date(automation.lastTriggeredAt).toLocaleString("zh-CN") : "尚未使用"}</dd></div></dl></details>
        </article>)}
      </div></section>;
    })}
    {automations.length === 0 && <div className="automation-empty"><ShieldCheck size={28} /><strong>还没有自动化</strong><span>当项目需要定期找 AI 帮忙时，在这里启用它。</span><button type="button" className="secondary-button" onClick={startCreate}><Plus size={15} />新增自动化</button></div>}
    {(creating || editing) && <div className="automation-editor" role="dialog" aria-modal="true"><header><strong>{creating ? "新增自动化" : "调整自动化"}</strong><button type="button" className="icon-button" onClick={() => { setCreating(false); setEditing(null); }} aria-label="关闭"><X size={17} /></button></header><div className="form-grid">
      {creating && <label>自动化 ID<input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="daily-news" /></label>}
      <label className={creating ? "" : "span-2"}>名称<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="每日 AI 日报" /></label>
      <label>项目位置<input value={draft.projectRoot} onChange={(event) => setDraft({ ...draft, projectRoot: event.target.value })} placeholder="/home/tasks/daily-news" /></label>
      <label>申请理由<input value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} placeholder="整理新闻并生成日报" /></label>
      {creating && <><label>使用方式<select value={draft.targetMode} onChange={(event) => setDraft({ ...draft, targetMode: event.target.value as TargetMode })}><option value="existing">绑定已有对话</option><option value="dedicated">启用时创建专用对话</option><option value="per-run">每次使用创建新对话</option></select></label>{draft.targetMode === "existing" ? <label>目标对话<select value={draft.conversationId} onChange={(event) => setDraft({ ...draft, conversationId: event.target.value })}>{sessions.map((session) => <option key={session.id} value={session.id}>{session.name ?? session.firstMessage}</option>)}</select></label> : <><label>助手<select value={draft.assistantId} onChange={(event) => setDraft({ ...draft, assistantId: event.target.value })}>{assistants.map((assistant) => <option key={assistant.id} value={assistant.id}>{assistant.manifest.name}</option>)}</select></label><label>工作区<select value={draft.workspaceId} onChange={(event) => setDraft({ ...draft, workspaceId: event.target.value })}><option value="">不使用工作区</option>{workspaces.filter((workspace) => !workspace.archived).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>{!draft.workspaceId && <label>工作目录<input value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="/home/projects/news" /></label>}</>}</>}
      <label>窗口内最多次数<input type="number" min="1" value={draft.maxCalls} onChange={(event) => setDraft({ ...draft, maxCalls: event.target.value })} /></label><label>窗口小时数<input type="number" min="1" value={draft.windowHours} onChange={(event) => setDraft({ ...draft, windowHours: event.target.value })} /></label><label>有效天数<input type="number" min="1" value={draft.expiryDays} onChange={(event) => setDraft({ ...draft, expiryDays: event.target.value })} /></label>
    </div><footer><button type="button" className="secondary-button" onClick={() => { setCreating(false); setEditing(null); }}>取消</button><button type="button" className="primary-button" disabled={busy !== null} onClick={() => void save()}><ShieldCheck size={15} />{creating ? "提交确认" : "保存调整"}</button></footer></div>}
  </div>;
}
