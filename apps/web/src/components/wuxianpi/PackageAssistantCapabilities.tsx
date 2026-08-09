"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle, RefreshCw, Store } from "lucide-react";
import type { PackageAssistantBinding } from "@/lib/package-market";
import { webApi } from "@/lib/web-api-client";

interface BoundPackageCapability {
  packageId: string;
  packageName: string;
  contributionNames: string[];
}

interface Props {
  assistantId: string;
  onOpenMarketplace?: () => void;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function packageCapabilityBindings(
  value: unknown,
  binding: Pick<PackageAssistantBinding, "enabledContributionIds">,
): BoundPackageCapability[] {
  const enabled = new Set(binding.enabledContributionIds);
  const packages = Array.isArray(record(value).packages) ? record(value).packages as unknown[] : [];
  return packages.flatMap((rawPackage) => {
    const pkg = record(rawPackage);
    const packageId = typeof pkg.packageId === "string" ? pkg.packageId : "";
    const contributions = Array.isArray(pkg.contributions) ? pkg.contributions : [];
    const contributionNames = contributions.flatMap((rawContribution) => {
      const row = record(rawContribution);
      const contribution = record(row.contribution ?? row);
      const id = typeof row.id === "string" ? row.id : typeof contribution.id === "string" ? contribution.id : "";
      if (!id || !enabled.has(id)) return [];
      return [typeof contribution.name === "string" ? contribution.name : id];
    });
    if (!packageId || contributionNames.length === 0) return [];
    return [{
      packageId,
      packageName: typeof pkg.name === "string" ? pkg.name : packageId,
      contributionNames,
    }];
  }).sort((left, right) => left.packageName.localeCompare(right.packageName, "zh-CN"));
}

export function PackageAssistantCapabilities({ assistantId, onOpenMarketplace }: Props) {
  const [packages, setPackages] = useState<BoundPackageCapability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [packagePayload, binding] = await Promise.all([
        webApi.request<unknown>("/packages"),
        webApi.packageAssistantBinding(assistantId),
      ]);
      setPackages(packageCapabilityBindings(packagePayload, binding));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [assistantId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section>
      <h3>市场绑定</h3>
      <div className="capability-list">
        {loading && <div className="wuxianpi-state"><LoaderCircle size={16} className="spin" /><span>正在读取 Package 绑定…</span></div>}
        {error && <div className="wuxianpi-state error"><span>{error}</span><button type="button" className="icon-button" onClick={() => void load()} aria-label="重试" title="重试"><RefreshCw size={16} /></button></div>}
        {!loading && !error && packages.map((pkg) => (
          <div key={pkg.packageId} className="capability-row">
            <Check size={17} />
            <span><strong>{pkg.packageName}</strong><small>{pkg.contributionNames.join(" · ")}</small></span>
            <em>已绑定</em>
          </div>
        ))}
        {!loading && !error && packages.length === 0 && <div className="wuxianpi-state">当前助手没有市场 Package 绑定。</div>}
      </div>
      {onOpenMarketplace && <button type="button" className="secondary-button compact" onClick={onOpenMarketplace}><Store size={15} />管理市场绑定</button>}
    </section>
  );
}
