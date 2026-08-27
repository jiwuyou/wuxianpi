"use client";

import { Archive, Copy, FolderInput, FolderPlus, MoreHorizontal, Pin, RotateCcw, Search, Split } from "lucide-react";
import { useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { AssistantSummary } from "@/lib/wuxianpi/contracts";

export interface SessionGroupSummary {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
}

type View = "recent" | "pinned" | "groups" | "ungrouped" | "archived";
type SessionAction = "actions" | "group" | null;

interface Props {
  sessions: SessionInfo[];
  assistants: AssistantSummary[];
  groups: SessionGroupSummary[];
  activeSessionId: string | null;
  onOpen: (session: SessionInfo) => void;
  onCreateGroup: () => void;
  onRenameGroup: (group: SessionGroupSummary) => void;
  onDeleteGroup: (group: SessionGroupSummary) => void;
  onBranch: (session: SessionInfo) => void;
  onCopySessionId: (session: SessionInfo) => void;
  onRename: (session: SessionInfo) => void;
  onUpdate: (session: SessionInfo, input: { archived?: boolean; groupId?: string | null; pinned?: boolean }) => void;
}

const VIEWS: Array<{ id: View; label: string }> = [
  { id: "recent", label: "最近" },
  { id: "pinned", label: "置顶" },
  { id: "groups", label: "分组" },
  { id: "ungrouped", label: "未整理" },
  { id: "archived", label: "归档" },
];

export function OrganizedConversationDrawer({ sessions, assistants, groups, activeSessionId, onOpen, onCreateGroup, onRenameGroup, onDeleteGroup, onBranch, onCopySessionId, onRename, onUpdate }: Props) {
  const [view, setView] = useState<View>("recent");
  const [query, setQuery] = useState("");
  const assistantNames = useMemo(() => new Map(assistants.map((assistant) => [assistant.id, assistant.manifest.name])), [assistants]);
  const groupNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return sessions.filter((session) => {
      if (view === "archived" ? !session.archived : session.archived) return false;
      if (view === "pinned" && !session.pinned) return false;
      if (view === "ungrouped" && session.groupId !== null) return false;
      if (!normalized) return true;
      return [session.name, session.firstMessage, assistantNames.get(session.assistantId ?? ""), groupNames.get(session.groupId ?? "")]
        .some((value) => value?.toLocaleLowerCase().includes(normalized));
    }).sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.modified.localeCompare(left.modified));
  }, [assistantNames, groupNames, query, sessions, view]);

  return (
    <div className="organized-conversations">
      <label className="conversation-search">
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、首条消息、分组" />
      </label>
      <div className="conversation-view-tabs" role="tablist" aria-label="对话视图">
        {VIEWS.map((item) => <button key={item.id} type="button" className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}
      </div>
      {view === "groups" ? (
        <GroupView groups={groups} sessions={visible} activeSessionId={activeSessionId} assistantNames={assistantNames} onOpen={onOpen} onUpdate={onUpdate} onBranch={onBranch} onCopySessionId={onCopySessionId} onRename={onRename} onCreateGroup={onCreateGroup} onRenameGroup={onRenameGroup} onDeleteGroup={onDeleteGroup} />
      ) : (
        <SessionList sessions={visible} groups={groups} activeSessionId={activeSessionId} assistantNames={assistantNames} onOpen={onOpen} onUpdate={onUpdate} onBranch={onBranch} onCopySessionId={onCopySessionId} onRename={onRename} emptyLabel={emptyLabel(view, query)} onCreateGroup={onCreateGroup} />
      )}
    </div>
  );
}

function GroupView({ groups, sessions, activeSessionId, assistantNames, onOpen, onUpdate, onBranch, onCopySessionId, onRename, onCreateGroup, onRenameGroup, onDeleteGroup }: {
  groups: SessionGroupSummary[]; sessions: SessionInfo[]; activeSessionId: string | null; assistantNames: Map<string, string>;
  onOpen: (session: SessionInfo) => void; onUpdate: Props["onUpdate"]; onBranch: Props["onBranch"]; onCopySessionId: Props["onCopySessionId"]; onRename: Props["onRename"]; onCreateGroup: () => void;
  onRenameGroup: Props["onRenameGroup"]; onDeleteGroup: Props["onDeleteGroup"];
}) {
  return <div className="conversation-group-list">
    <button type="button" className="conversation-create-group" onClick={onCreateGroup}><FolderPlus size={16} />新建分组</button>
    {groups.map((group) => {
      const items = sessions.filter((session) => session.groupId === group.id);
      return <section key={group.id}>
        <header><span className="conversation-group-swatch" style={{ background: group.color ?? "var(--accent)" }} /><strong>{group.name}</strong><small>{items.length}</small><button type="button" title="重命名分组" onClick={() => onRenameGroup(group)}>改名</button><button type="button" title="删除分组" onClick={() => onDeleteGroup(group)}>删除</button></header>
        <SessionList sessions={items} groups={groups} activeSessionId={activeSessionId} assistantNames={assistantNames} onOpen={onOpen} onUpdate={onUpdate} onBranch={onBranch} onCopySessionId={onCopySessionId} onRename={onRename} emptyLabel="暂无对话" onCreateGroup={onCreateGroup} />
      </section>;
    })}
    {groups.length === 0 && <div className="conversation-empty">还没有分组</div>}
  </div>;
}

function SessionList({ sessions, groups, activeSessionId, assistantNames, onOpen, onUpdate, onBranch, onCopySessionId, onRename, emptyLabel, onCreateGroup }: {
  sessions: SessionInfo[]; groups: SessionGroupSummary[]; activeSessionId: string | null; assistantNames: Map<string, string>;
  onOpen: (session: SessionInfo) => void; onUpdate: Props["onUpdate"]; onBranch: Props["onBranch"]; onCopySessionId: Props["onCopySessionId"]; onRename: Props["onRename"]; emptyLabel: string; onCreateGroup: () => void;
}) {
  if (sessions.length === 0) return <div className="conversation-empty">{emptyLabel}</div>;
  return <div className="conversation-list">{sessions.map((session) => (
    <SessionRow key={session.id} session={session} groups={groups} active={session.id === activeSessionId} assistantName={assistantNames.get(session.assistantId ?? "") ?? "Pi 会话"} onOpen={onOpen} onUpdate={onUpdate} onBranch={onBranch} onCopySessionId={onCopySessionId} onRename={onRename} onCreateGroup={onCreateGroup} />
  ))}</div>;
}

function SessionRow({ session, groups, active, assistantName, onOpen, onUpdate, onBranch, onCopySessionId, onRename, onCreateGroup }: {
  session: SessionInfo; groups: SessionGroupSummary[]; active: boolean; assistantName: string;
  onOpen: (session: SessionInfo) => void; onUpdate: Props["onUpdate"]; onBranch: Props["onBranch"]; onCopySessionId: Props["onCopySessionId"]; onRename: Props["onRename"]; onCreateGroup: () => void;
}) {
  const [action, setAction] = useState<SessionAction>(null);
  const close = () => setAction(null);
  return <div className={`conversation-item ${active ? "active" : ""}`}>
    <div className="conversation-item-line">
      <button type="button" className="conversation-item-main" onClick={() => onOpen(session)}>
        <strong>{session.name || session.firstMessage || "新对话"}</strong>
        <small>{assistantName} · {session.messageCount} 条 · {relativeTime(session.modified)}</small>
      </button>
      <button type="button" className={`conversation-item-more ${action ? "active" : ""}`} title="会话操作" aria-label="会话操作" aria-expanded={action !== null} onClick={() => setAction(action ? null : "actions")}><MoreHorizontal size={17} /></button>
    </div>
    {action === "actions" && <div className="conversation-actions">
      <button type="button" onClick={() => { onUpdate(session, { pinned: !session.pinned }); close(); }}><Pin size={14} />{session.pinned ? "取消置顶" : "置顶"}</button>
      <button type="button" onClick={() => setAction("group")}><FolderInput size={14} />移动到分组</button>
      <button type="button" onClick={() => { onCopySessionId(session); close(); }}><Copy size={14} />复制会话 ID</button>
      <button type="button" onClick={() => { onBranch(session); close(); }}><Split size={14} />分支到新聊天</button>
      <button type="button" onClick={() => { onRename(session); close(); }}><span className="conversation-action-symbol">✎</span>重命名</button>
      <button type="button" onClick={() => { onUpdate(session, { archived: !session.archived }); close(); }}>{session.archived ? <RotateCcw size={14} /> : <Archive size={14} />}{session.archived ? "恢复" : "归档"}</button>
    </div>}
    {action === "group" && <div className="conversation-group-picker">
      <button type="button" onClick={() => { onUpdate(session, { groupId: null }); close(); }}>未整理</button>
      {groups.map((group) => <button type="button" key={group.id} onClick={() => { onUpdate(session, { groupId: group.id }); close(); }}><span className="conversation-group-swatch" style={{ background: group.color ?? "var(--accent)" }} />{group.name}</button>)}
      <button type="button" className="conversation-picker-new" onClick={onCreateGroup}><FolderPlus size={14} />新建分组</button>
      <button type="button" className="conversation-picker-back" onClick={() => setAction("actions")}>返回</button>
    </div>}
  </div>;
}

function emptyLabel(view: View, query: string): string {
  if (query.trim()) return "没有匹配的对话";
  return ({ recent: "还没有对话", pinned: "还没有置顶对话", groups: "还没有分组", ungrouped: "没有未整理对话", archived: "没有归档对话" })[view];
}

function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}
