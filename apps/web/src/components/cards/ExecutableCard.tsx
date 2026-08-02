"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, LoaderCircle, Play, RotateCcw, Square } from "lucide-react";
import type { CardField, ExecutableCardState, JsonValue } from "@/lib/executable-card";

interface Props {
  card: ExecutableCardState;
  onSubmit: (cardId: string, workflowDigest: string, values: Record<string, JsonValue>) => Promise<void>;
  onCancel: (cardId: string) => Promise<void>;
}

export function ExecutableCard({ card, onSubmit, onCancel }: Props) {
  const defaults = useMemo(() => initialValues(card), [card.spec.cardId]);
  const [values, setValues] = useState<Record<string, JsonValue>>(defaults);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (card.values) setValues(card.values);
  }, [card.values]);

  const running = card.state === "running";
  const completed = card.state === "success";
  const canSubmit = !running && !completed;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    try {
      await onSubmit(card.spec.cardId, card.spec.workflowDigest, values);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", overflow: "hidden", boxShadow: "0 6px 20px rgba(0,0,0,0.06)" }}>
      <header style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, lineHeight: 1.35, color: "var(--text)", fontWeight: 700 }}>{card.spec.title}</h3>
          {card.spec.description && <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{card.spec.description}</p>}
        </div>
        <Status state={card.state} />
      </header>

      <form onSubmit={submit} style={{ padding: 14, display: "grid", gap: 12 }}>
        {card.spec.fields.map((field) => field.type === "hidden" ? null : (
          <Field key={field.id} field={field} value={values[field.id]} disabled={running || completed}
            onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))} />
        ))}

        {(localError || card.error) && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "#dc2626", fontSize: 12, lineHeight: 1.45 }}>
            <CircleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{localError ?? card.error?.message}</span>
          </div>
        )}

        {card.state === "success" && card.result !== undefined && <Result value={card.result} />}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 2 }}>
          {running && (
            <button type="button" onClick={() => void onCancel(card.spec.cardId).catch((error) => setLocalError(error instanceof Error ? error.message : String(error)))} style={secondaryButtonStyle}>
              <Square size={14} /> Cancel
            </button>
          )}
          {canSubmit && (
            <button type="submit" style={primaryButtonStyle}>
              {card.state === "error" || card.state === "cancelled" || card.state === "interrupted" ? <RotateCcw size={14} /> : <Play size={14} />}
              {card.state === "draft" ? card.spec.submitLabel : "Run again"}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function Field({ field, value, disabled, onChange }: { field: CardField; value: JsonValue | undefined; disabled: boolean; onChange: (value: JsonValue) => void }) {
  const label = <label htmlFor={`card-field-${field.id}`} style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{field.label}{field.required ? " *" : ""}</label>;
  const common = { id: `card-field-${field.id}`, disabled, required: field.required, placeholder: field.placeholder, style: inputStyle };
  if (field.type === "checkbox" || field.type === "switch") {
    return <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12, color: "var(--text)", cursor: disabled ? "default" : "pointer" }}>
      <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} />
      {field.label}
    </label>;
  }
  if (field.type === "textarea") {
    return <div style={fieldWrapStyle}>{label}<textarea {...common} rows={field.rows ?? 5} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} style={{ ...inputStyle, resize: "vertical", minHeight: 88 }} /></div>;
  }
  if (field.type === "select") {
    const selected = optionIndex(field, value);
    return <div style={fieldWrapStyle}>{label}<select {...common} value={selected} onChange={(event) => onChange(field.options?.[Number(event.target.value)]?.value ?? "")}>
      {!field.required && <option value="">Select</option>}
      {(field.options ?? []).map((option, index) => <option key={index} value={index}>{option.label}</option>)}
    </select></div>;
  }
  if (field.type === "multi-select") {
    const selected = Array.isArray(value) ? value : [];
    return <div style={fieldWrapStyle}>{label}<select {...common} multiple value={(field.options ?? []).flatMap((option, index) => selected.some((item) => JSON.stringify(item) === JSON.stringify(option.value)) ? [String(index)] : [])}
      onChange={(event) => onChange([...event.target.selectedOptions].map((option) => field.options?.[Number(option.value)]?.value ?? ""))}>
      {(field.options ?? []).map((option, index) => <option key={index} value={index}>{option.label}</option>)}
    </select></div>;
  }
  if (field.type === "tags") {
    return <div style={fieldWrapStyle}>{label}<input {...common} type="text" value={Array.isArray(value) ? value.join(", ") : ""}
      onChange={(event) => onChange(event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean))} /></div>;
  }
  const inputType = field.type === "number" ? "number" : field.type === "password" ? "password" : field.type === "datetime" ? "datetime-local" : field.type;
  return <div style={fieldWrapStyle}>{label}<input {...common} type={inputType} min={field.min} max={field.max}
    value={field.type === "number" ? (typeof value === "number" ? value : "") : (typeof value === "string" ? value : "")}
    onChange={(event) => onChange(field.type === "number" ? (event.target.value === "" ? null : Number(event.target.value)) : event.target.value)} /></div>;
}

function Status({ state }: { state: ExecutableCardState["state"] }) {
  const config = state === "running" ? { text: "Running", color: "var(--accent)", icon: <LoaderCircle size={14} className="animate-spin" /> }
    : state === "success" ? { text: "Completed", color: "#16a34a", icon: <Check size={14} /> }
      : state === "error" ? { text: "Failed", color: "#dc2626", icon: <CircleAlert size={14} /> }
        : state === "cancelled" ? { text: "Cancelled", color: "var(--text-muted)", icon: <Square size={13} /> }
          : state === "interrupted" ? { text: "Interrupted", color: "#d97706", icon: <CircleAlert size={14} /> }
            : { text: "Ready", color: "var(--text-muted)", icon: <Play size={13} /> };
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: config.color, fontSize: 11, flexShrink: 0 }}>{config.icon}{config.text}</span>;
}

function Result({ value }: { value: unknown }) {
  return <div style={{ border: "1px solid color-mix(in srgb, #16a34a 35%, var(--border))", background: "color-mix(in srgb, #16a34a 6%, var(--bg))", borderRadius: 6, padding: 10 }}>
    <div style={{ color: "#16a34a", fontSize: 11, fontWeight: 700, marginBottom: 6 }}>Result</div>
    <pre style={{ margin: 0, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 260, overflow: "auto" }}>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
  </div>;
}

function initialValues(card: ExecutableCardState): Record<string, JsonValue> {
  return Object.fromEntries(card.spec.fields.flatMap((field) => {
    const value = card.values?.[field.id] ?? field.defaultValue;
    if (value !== undefined) return [[field.id, value]];
    if (field.type === "checkbox" || field.type === "switch") return [[field.id, false]];
    if (field.type === "tags" || field.type === "multi-select") return [[field.id, []]];
    return [[field.id, ""]];
  }));
}

function optionIndex(field: CardField, value: JsonValue | undefined): string {
  const index = (field.options ?? []).findIndex((option) => JSON.stringify(option.value) === JSON.stringify(value));
  return index < 0 ? "" : String(index);
}

const fieldWrapStyle: React.CSSProperties = { display: "grid", gap: 5 };
const inputStyle: React.CSSProperties = { width: "100%", minWidth: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", padding: "8px 9px", fontSize: 13, lineHeight: 1.4, outline: "none" };
const primaryButtonStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 34, padding: "7px 12px", border: "1px solid var(--accent)", borderRadius: 6, background: "var(--accent)", color: "white", fontSize: 12, fontWeight: 650, cursor: "pointer" };
const secondaryButtonStyle: React.CSSProperties = { ...primaryButtonStyle, borderColor: "var(--border)", background: "var(--bg)", color: "var(--text-muted)" };
