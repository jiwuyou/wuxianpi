import { useEffect, useRef, useState } from "react";
import type { ExtensionUiRequest } from "@/lib/types";
import { FloatingExtensionWindow } from "./FloatingExtensionWindow";
import type { ExtensionUiDialogRequest, ExtensionUiDialogResponse } from "./ExtensionRequestContent";

export function FloatingExtensionLayer({
  requests,
  onRespond,
}: {
  requests: ExtensionUiDialogRequest[];
  onRespond: (request: ExtensionUiDialogRequest, response: ExtensionUiDialogResponse) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [order, setOrder] = useState<string[]>([]);

  useEffect(() => {
    const element = layerRef.current;
    if (!element) return;
    const visualViewport = window.visualViewport;
    const update = () => {
      const width = Math.max(1, Math.round(Math.min(element.clientWidth, visualViewport?.width ?? element.clientWidth)));
      const height = Math.max(1, Math.round(Math.min(element.clientHeight, visualViewport?.height ?? element.clientHeight)));
      setViewport((current) => current.width === width && current.height === height ? current : { width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    window.addEventListener("orientationchange", update);
    return () => {
      observer.disconnect();
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  useEffect(() => {
    setOrder((current) => {
      const active = new Set(requests.map((request) => request.id));
      const retained = current.filter((id) => active.has(id));
      for (const request of requests) if (!retained.includes(request.id)) retained.push(request.id);
      return retained;
    });
  }, [requests]);

  const focus = (id: string) => setOrder((current) => [...current.filter((item) => item !== id), id]);

  return (
    <div ref={layerRef} className="floating-extension-layer" aria-live="polite">
      {viewport.width > 1 && requests.map((request, index) => (
        <FloatingExtensionWindow
          key={request.id}
          request={request}
          viewport={viewport}
          offset={index}
          zIndex={100 + Math.max(0, order.indexOf(request.id))}
          onFocus={() => focus(request.id)}
          onRespond={onRespond}
        />
      ))}
    </div>
  );
}

export type { ExtensionUiDialogRequest, ExtensionUiDialogResponse };
export type ExtensionUiDialogEvent = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
