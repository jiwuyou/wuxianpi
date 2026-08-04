"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, RefreshCw, Store } from "lucide-react";
import type {
  FunctionalAssistantSharingMode,
  PackageAssistantBinding,
} from "@/lib/package-market";
import { webApi } from "@/lib/web-api-client";

interface FunctionalAssistantSummary {
  id: string;
  packageId: string;
  name: string;
  description?: string;
  enabled: boolean;
}

interface Props {
  assistantId: string;
  onOpenMarketplace?: () => void;
}

const SHARING_OPTIONS: Array<{ value: FunctionalAssistantSharingMode; label: string }> = [
  { value: "hybrid", label: "共享校正经验，私有进度" },
  { value: "isolated", label: "完全独立" },
  { value: "shared", label: "完全共享" },
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function functionalAssistantCandidates(value: unknown): FunctionalAssistantSummary[] {
  const packages = Array.isArray(record(value).packages) ? record(value).packages as unknown[] : [];
  return packages.flatMap((rawPackage) => {
    const pkg = record(rawPackage);
    const packageId = typeof pkg.packageId === "string" ? pkg.packageId : "";
    const contributions = Array.isArray(pkg.contributions) ? pkg.contributions : [];
    return contributions.flatMap((rawContribution) => {
      const row = record(rawContribution);
      const contribution = record(row.contribution ?? row);
      const id = typeof row.id === "string" ? row.id : typeof contribution.id === "string" ? contribution.id : "";
      if (!id || contribution.type !== "wuxianpi.assistantTemplate" || contribution.kind !== "functional") return [];
      return [{
        id,
        packageId,
        name: typeof contribution.name === "string" ? contribution.name : id,
        ...(typeof contribution.description === "string" ? { description: contribution.description } : {}),
        enabled: row.enabled === true,
      }];
    });
  }).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function updateFunctionalAssistantBinding(
  binding: PackageAssistantBinding,
  functionId: string,
  enabled: boolean,
  sharingMode: FunctionalAssistantSharingMode = "hybrid",
): PackageAssistantBinding {
  const enabledContributionIds = enabled
    ? [...new Set([...binding.enabledContributionIds, functionId])]
    : binding.enabledContributionIds.filter((id) => id !== functionId);
  const functionalAssistants = { ...binding.functionalAssistants };
  if (enabled) functionalAssistants[functionId] = { sharingMode };
  else delete functionalAssistants[functionId];
  return { ...binding, enabledContributionIds, functionalAssistants };
}

export function FunctionalAssistantBindings({ assistantId, onOpenMarketplace }: Props) {
  const [candidates, setCandidates] = useState<FunctionalAssistantSummary[]>([]);
  const [binding, setBinding] = useState<PackageAssistantBinding | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirtyPackageId, setDirtyPackageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [packagePayload, nextBinding] = await Promise.all([
        webApi.request<unknown>("/packages"),
        webApi.packageAssistantBinding(assistantId),
      ]);
      setCandidates(functionalAssistantCandidates(packagePayload));
      setBinding(nextBinding);
      setDirtyPackageId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [assistantId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2400);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const missingBindings = useMemo(() => {
    if (!binding) return [];
    const installed = new Set(candidates.map((item) => item.id));
    return Object.keys(binding.functionalAssistants).filter((id) => !installed.has(id));
  }, [binding, candidates]);

  const patchBinding = (candidate: FunctionalAssistantSummary, enabled: boolean, mode?: FunctionalAssistantSharingMode) => {
    setBinding((current) => current
      ? updateFunctionalAssistantBinding(current, candidate.id, enabled, mode ?? current.functionalAssistants[candidate.id]?.sharingMode ?? "hybrid")
      : current);
    setDirtyPackageId(candidate.packageId || candidate.id.split("/")[0] || "functional-assistants");
    setSaved(false);
  };

  const save = async () => {
    if (!binding || !dirtyPackageId) return;
    setSaving(true);
    setError(null);
    try {
      await webApi.setPackageAssistantBinding(
        dirtyPackageId,
        assistantId,
        binding.enabledContributionIds,
        binding.experienceSpaces,
        binding.functionalAssistants,
      );
      setDirtyPackageId(null);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="functional-assistant-bindings">
      <header className="functional-assistant-toolbar">
        <div>
          <strong>功能助手</strong>
          <small>作为带独立存储的 Skill 绑定到当前助手</small>
        </div>
        <div>
          <button type="button" className="icon-button" onClick={() => void load()} disabled={loading || saving} aria-label="刷新功能助手" title="刷新">
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </button>
          {onOpenMarketplace && <button type="button" className="secondary-button compact" onClick={onOpenMarketplace}><Store size={15} />市场</button>}
        </div>
      </header>

      {error && <div className="wuxianpi-state error"><span>{error}</span></div>}
      {loading && <div className="wuxianpi-state"><LoaderCircle size={17} className="spin" /><span>正在读取已安装功能助手…</span></div>}
      {!loading && candidates.length === 0 && (
        <div className="functional-assistant-empty">
          <strong>尚未安装功能助手</strong>
          {onOpenMarketplace && <button type="button" className="secondary-button compact" onClick={onOpenMarketplace}><Store size={15} />打开市场</button>}
        </div>
      )}
      {!loading && binding && candidates.length > 0 && (
        <div className="functional-assistant-list">
          {candidates.map((candidate) => {
            const active = Boolean(binding.functionalAssistants[candidate.id]);
            const mode = binding.functionalAssistants[candidate.id]?.sharingMode ?? "hybrid";
            return (
              <div key={candidate.id} className={`functional-assistant-row ${!candidate.enabled ? "unavailable" : ""}`}>
                <label>
                  <input
                    type="checkbox"
                    checked={active}
                    disabled={(!candidate.enabled && !active) || saving}
                    onChange={(event) => patchBinding(candidate, event.target.checked)}
                  />
                  <span><strong>{candidate.name}</strong><small>{candidate.description ?? candidate.id}</small></span>
                </label>
                <select
                  value={mode}
                  disabled={!active || saving}
                  aria-label={`${candidate.name} 存储模式`}
                  onChange={(event) => patchBinding(candidate, true, event.target.value as FunctionalAssistantSharingMode)}
                >
                  {SHARING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      )}
      {missingBindings.length > 0 && <p className="functional-assistant-missing">{missingBindings.length} 个已绑定功能助手当前不可用，原绑定仍被保留。</p>}
      <footer className="functional-assistant-footer">
        {saved && <span><Check size={14} />绑定已保存</span>}
        <button type="button" className="primary-button" disabled={!dirtyPackageId || saving || loading} onClick={() => void save()}>
          {saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存功能助手
        </button>
      </footer>
    </div>
  );
}
