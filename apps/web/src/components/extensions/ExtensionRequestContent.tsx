import { useEffect, useState } from "react";
import type { ExtensionUiRequest } from "@/lib/types";
import { MarkdownBody } from "../MarkdownBody";

export type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
export type ExtensionUiDialogResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export function ExtensionRequestContent({
  request,
  onRespond,
}: {
  request: ExtensionUiDialogRequest;
  onRespond: (response: ExtensionUiDialogResponse) => void;
}) {
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submit = () => {
    if (request.method === "confirm") onRespond({ confirmed: true });
    else onRespond({ value });
  };

  return (
    <div className="extension-window-layout">
      <div className="extension-window-content">
        {request.method === "confirm" && <MarkdownBody>{request.message}</MarkdownBody>}
        {request.method === "select" && (
          <div className="extension-window-options">
            {request.options.map((option) => (
              <button key={option} type="button" className="extension-window-option" onClick={() => onRespond({ value: option })}>
                {option}
              </button>
            ))}
          </div>
        )}
        {request.method === "input" && (
          <input
            autoFocus
            className="extension-window-input"
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
              if (event.key === "Escape") onRespond({ cancelled: true });
            }}
          />
        )}
        {request.method === "editor" && (
          <textarea
            autoFocus
            className="extension-window-editor"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onRespond({ cancelled: true });
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit();
            }}
          />
        )}
      </div>

      <div className="extension-window-actions">
        <button type="button" className="extension-window-button" onClick={() => onRespond({ cancelled: true })}>取消</button>
        {request.method === "confirm" ? (
          <button type="button" className="extension-window-button extension-window-button-primary" onClick={submit}>确认</button>
        ) : request.method !== "select" ? (
          <button type="button" className="extension-window-button extension-window-button-primary" onClick={submit}>提交</button>
        ) : null}
      </div>
    </div>
  );
}
