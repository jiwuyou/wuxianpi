"use client";

import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, FolderOpen, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import type { Workspace, WorkspaceCreateRequest, WorkspaceUpdateRequest } from "@/lib/wuxianpi/contracts";
import { createWorkspace, deleteWorkspace, updateWorkspace } from "./api";
import { webApi } from "@/lib/web-api-client";

interface Props {
  workspaces: Workspace[];
  onChanged: (workspaces: Workspace[]) => void;
}

type WorkspaceDraft = {
  id: string;
  name: string;
  rootCwd: string;
  instructions: string;
  memory: string;
};

const EMPTY_DRAFT: WorkspaceDraft = { id: "", name: "", rootCwd: "", instructions: "", memory: "" };

function draftOf(workspace?: Workspace): WorkspaceDraft {
  return workspace ? {
    id: workspace.id,
    name: workspace.name,
    rootCwd: workspace.rootCwd,
    instructions: workspace.instructions,
    memory: workspace.memory,
  } : EMPTY_DRAFT;
}

export function WorkspaceManager({ workspaces, onChanged }: Props) {
  const [editing, setEditing] = useState<Workspace | null | undefined>(undefined);
  const [draft, setDraft] = useState<WorkspaceDraft>(EMPTY_DRAFT);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPath, setPickerPath] = useState<string | null>(null);
  const [pickerParent, setPickerParent] = useState<string | null>(null);
  const [pickerEntries, setPickerEntries] = useState<Array<{ name: string; path: string; readable: boolean; writable: boolean; selectable: boolean }>>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  useEffect(() => setDraft(draftOf(editing ?? undefined)), [editing]);

  const openPicker = async () => {
    setPickerOpen(true);
    setPickerError(null);
    try {
      const roots = await webApi.filesystemRoots();
      await loadPickerDirectory(roots[0]?.path ?? "/");
    } catch (reason) { setPickerError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const loadPickerDirectory = async (path: string) => {
    setPickerLoading(true);
    setPickerError(null);
    try {
      const data = await webApi.listDirectories(path);
      setPickerPath(data.path);
      setPickerParent(data.parent);
      setPickerEntries(data.entries);
    } catch (reason) { setPickerError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPickerLoading(false); }
  };

  const createPickerDirectory = async () => {
    if (!pickerPath) return;
    const name = window.prompt("新建文件夹");
    if (!name?.trim()) return;
    try {
      const created = await webApi.createDirectory(pickerPath, name.trim());
      await loadPickerDirectory(created.path);
    } catch (reason) { setPickerError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const sorted = [...workspaces]
    .filter((workspace) => includeArchived || !workspace.archived)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, "zh-CN"));

  const save = async () => {
    if (!draft.name.trim() || !draft.rootCwd.trim()) {
      setError("请填写工作区名称和根路径");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input: WorkspaceCreateRequest | WorkspaceUpdateRequest = {
        name: draft.name.trim(),
        rootCwd: draft.rootCwd.trim(),
        instructions: draft.instructions,
        memory: draft.memory,
        ...(!editing && draft.id.trim() ? { id: draft.id.trim() } : {}),
      };
      const saved = editing
        ? await updateWorkspace(editing.id, input)
        : await createWorkspace(input as WorkspaceCreateRequest);
      onChanged([saved, ...workspaces.filter((workspace) => workspace.id !== saved.id)]);
      setEditing(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async (workspace: Workspace) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await updateWorkspace(workspace.id, { archived: !workspace.archived });
      onChanged(workspaces.map((item) => item.id === saved.id ? saved : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (workspace: Workspace) => {
    if (!window.confirm(`删除工作区“${workspace.name}”？已有会话不会被删除，但会变为无工作区归属。`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteWorkspace(workspace.id);
      onChanged(workspaces.filter((item) => item.id !== workspace.id));
      if (editing?.id === workspace.id) setEditing(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workspace-manager wuxianpi-page">
      <header className="workspace-manager-header">
        <div><span className="eyebrow">WORKSPACES</span><h2>工作区</h2></div>
        <div>
          <label className="check-row"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />显示已归档</label>
          <button type="button" className="primary-button" onClick={() => setEditing(null)}><Plus size={16} />新建</button>
        </div>
      </header>

      {error && <div className="wuxianpi-state error"><span>{error}</span></div>}
      <div className="workspace-list">
        {sorted.map((workspace) => (
          <div key={workspace.id} className={`workspace-row ${workspace.archived ? "archived" : ""}`}>
            <FolderOpen size={18} />
            <span><strong>{workspace.name}</strong><small>{workspace.rootCwd}</small></span>
            <em>{workspace.archived ? "已归档" : "可用"}</em>
            <div>
              <button type="button" className="icon-button" onClick={() => setEditing(workspace)} aria-label={`编辑 ${workspace.name}`} title="编辑"><Pencil size={15} /></button>
              <button type="button" className="icon-button" disabled={busy} onClick={() => void toggleArchive(workspace)} aria-label={workspace.archived ? `恢复 ${workspace.name}` : `归档 ${workspace.name}`} title={workspace.archived ? "恢复" : "归档"}>{workspace.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}</button>
              <button type="button" className="icon-button danger" disabled={busy} onClick={() => void remove(workspace)} aria-label={`删除 ${workspace.name}`} title="删除"><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
        {sorted.length === 0 && <div className="workspace-empty"><FolderOpen size={24} /><strong>还没有工作区</strong><button type="button" className="secondary-button compact" onClick={() => setEditing(null)}><Plus size={15} />新建工作区</button></div>}
      </div>

      {editing !== undefined && (
        <div className="workspace-editor" role="dialog" aria-modal="false" aria-label={editing ? "编辑工作区" : "新建工作区"}>
          <header><strong>{editing ? "编辑工作区" : "新建工作区"}</strong><button type="button" className="icon-button" onClick={() => setEditing(undefined)} aria-label="关闭"><X size={17} /></button></header>
          <div className="form-grid">
            {!editing && <label>工作区 ID<input value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} placeholder="leetcode" /></label>}
            <label className={editing ? "span-2" : ""}>名称<input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="LeetCode 训练" /></label>
            <label className="span-2">根路径
              <div className="workspace-path-input"><input value={draft.rootCwd} onChange={(event) => setDraft((current) => ({ ...current, rootCwd: event.target.value }))} placeholder="/data/data/com.termux/files/home/projects/leetcode" /><button type="button" className="secondary-button compact" onClick={() => void openPicker()}><FolderOpen size={15} />选择目录</button></div>
            </label>
            <label className="span-2">INSTRUCTIONS.md<textarea value={draft.instructions} onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))} rows={8} /></label>
            <label className="span-2">MEMORY.md<textarea value={draft.memory} onChange={(event) => setDraft((current) => ({ ...current, memory: event.target.value }))} rows={6} /></label>
          </div>
          <footer><button type="button" className="secondary-button" onClick={() => setEditing(undefined)}>取消</button><button type="button" className="primary-button" disabled={busy} onClick={() => void save()}><Save size={16} />{busy ? "保存中…" : "保存工作区"}</button></footer>
        </div>
      )}

      {pickerOpen && <DirectoryPicker
        path={pickerPath}
        parent={pickerParent}
        entries={pickerEntries}
        loading={pickerLoading}
        error={pickerError}
        onClose={() => setPickerOpen(false)}
        onOpen={(path) => void loadPickerDirectory(path)}
        onSelect={(path) => { setDraft((current) => ({ ...current, rootCwd: path })); setPickerOpen(false); }}
        onCreate={() => void createPickerDirectory()}
      />}
    </div>
  );
}

function DirectoryPicker({ path, parent, entries, loading, error, onClose, onOpen, onSelect, onCreate }: {
  path: string | null;
  parent: string | null;
  entries: Array<{ name: string; path: string; readable: boolean; writable: boolean; selectable: boolean }>;
  loading: boolean; error: string | null; onClose: () => void; onOpen: (path: string) => void; onSelect: (path: string) => void; onCreate: () => void;
}) {
  return <div className="wuxianpi-modal-backdrop" role="dialog" aria-modal="true" aria-label="选择工作区根目录">
    <div className="directory-picker">
      <header><div><strong>选择工作区根目录</strong><small>{path ?? "正在加载…"}</small></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>
      {error && <div className="wuxianpi-state error">{error}</div>}
      <div className="directory-picker-list">{loading ? <div className="conversation-empty">加载中…</div> : entries.length === 0 ? <div className="conversation-empty">没有可进入的子文件夹</div> : entries.map((entry) => <button type="button" key={entry.path} disabled={!entry.readable} onClick={() => onOpen(entry.path)}><FolderOpen size={17} /><span>{entry.name}</span><em>›</em></button>)}</div>
      <footer><button type="button" className="secondary-button" disabled={!parent || loading} onClick={() => parent && onOpen(parent)}>返回上级</button><button type="button" className="secondary-button" disabled={!path || loading} onClick={onCreate}><Plus size={15} />新建文件夹</button><button type="button" className="primary-button" disabled={!path || loading} onClick={() => path && onSelect(path)}>选择当前目录</button></footer>
    </div>
  </div>;
}
