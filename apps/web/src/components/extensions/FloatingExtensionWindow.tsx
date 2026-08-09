import { useCallback, useEffect, useRef } from "react";
import { GripVertical, Maximize2, Move, RotateCcw, X } from "lucide-react";
import { Rnd } from "react-rnd";
import {
  floatingWindowNeedsRecovery,
  floatingWindowWidthLimits,
  recoverFloatingWindowGeometry,
  type FloatingWindowViewport,
} from "@/lib/floating-window";
import { useFloatingWindowGeometry } from "@/hooks/useFloatingWindowGeometry";
import {
  ExtensionRequestContent,
  type ExtensionUiDialogRequest,
  type ExtensionUiDialogResponse,
} from "./ExtensionRequestContent";

export function FloatingExtensionWindow({
  request,
  viewport,
  offset,
  zIndex,
  onFocus,
  onRespond,
}: {
  request: ExtensionUiDialogRequest;
  viewport: FloatingWindowViewport;
  offset: number;
  zIndex: number;
  onFocus: () => void;
  onRespond: (request: ExtensionUiDialogRequest, response: ExtensionUiDialogResponse) => void;
}) {
  const respondedRef = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const storageKey = `wuxianpi:floating-window:${request.method}`;
  const { geometry, update, commit, reset } = useFloatingWindowGeometry(storageKey, viewport, offset, request.method);
  const widthLimits = floatingWindowWidthLimits(viewport.width, viewport.height);
  const needsRecovery = floatingWindowNeedsRecovery(geometry, viewport);

  const respond = useCallback((response: ExtensionUiDialogResponse) => {
    if (respondedRef.current) return;
    respondedRef.current = true;
    onRespond(request, response);
  }, [onRespond, request]);

  useEffect(() => {
    const deadline = request.expiresAt ?? (request.timeout ? Date.now() + request.timeout : null);
    if (deadline === null) return;
    const timer = window.setTimeout(() => respond({ cancelled: true }), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [request.expiresAt, request.timeout, respond]);

  const focusWindow = () => {
    onFocus();
    sectionRef.current?.focus({ preventScroll: true });
  };

  const fitViewport = () => {
    commit({
      x: (viewport.width - widthLimits.max) / 2,
      y: 12,
      width: widthLimits.max,
      height: Math.max(180, viewport.height - 24),
    });
  };

  const recoverWindow = () => commit(recoverFloatingWindowGeometry(geometry, viewport), geometry.height);

  return (
    <>
      <Rnd
        className="floating-extension-window"
        style={{ zIndex }}
        position={{ x: geometry.x, y: geometry.y }}
        size={{ width: geometry.width, height: geometry.height ?? "auto" }}
        minWidth={widthLimits.min}
        maxWidth={widthLimits.max}
        minHeight={160}
        dragHandleClassName="floating-extension-window-handle"
        cancel="button,input,textarea,a,.extension-window-content"
        onMouseDown={focusWindow}
        onTouchStart={focusWindow}
        onDrag={(_event, data) => update({ ...geometry, x: data.x, y: data.y })}
        onDragStop={(_event, data) => commit({ ...geometry, x: data.x, y: data.y })}
        onResize={(_event, _direction, element, _delta, position) => update({
          x: position.x,
          y: position.y,
          width: element.offsetWidth,
          height: element.offsetHeight,
        }, element.offsetHeight)}
        onResizeStop={(_event, _direction, element, _delta, position) => commit({
          x: position.x,
          y: position.y,
          width: element.offsetWidth,
          height: element.offsetHeight,
        }, element.offsetHeight)}
        resizeHandleClasses={{
          top: "floating-resize-handle floating-resize-handle-top",
          right: "floating-resize-handle floating-resize-handle-right",
          bottom: "floating-resize-handle floating-resize-handle-bottom",
          left: "floating-resize-handle floating-resize-handle-left",
          topRight: "floating-resize-handle floating-resize-handle-corner",
          bottomRight: "floating-resize-handle floating-resize-handle-corner",
          bottomLeft: "floating-resize-handle floating-resize-handle-corner",
          topLeft: "floating-resize-handle floating-resize-handle-corner",
        }}
      >
        <section
          ref={sectionRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={`extension-window-title-${request.id}`}
          className="floating-extension-window-shell"
          tabIndex={-1}
          onKeyDown={(event) => { if (event.key === "Escape") respond({ cancelled: true }); }}
        >
          <header
            className="floating-extension-window-handle"
            onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest("button")) reset(); }}
          >
            <GripVertical size={17} aria-hidden="true" />
            <div className="floating-extension-window-title-wrap">
              <div id={`extension-window-title-${request.id}`} className="floating-extension-window-title">{request.title}</div>
              <div className="floating-extension-window-subtitle">扩展请求</div>
            </div>
            <div className="floating-extension-window-tools">
              <button type="button" title="适应视口" aria-label="适应视口" onClick={fitViewport}><Maximize2 size={16} /></button>
              <button type="button" title="恢复默认布局" aria-label="恢复默认布局" onClick={reset}><RotateCcw size={16} /></button>
              <button type="button" title="取消" aria-label="取消" onClick={() => respond({ cancelled: true })}><X size={17} /></button>
            </div>
          </header>
          <ExtensionRequestContent request={request} onRespond={respond} />
        </section>
      </Rnd>
      {needsRecovery && (
        <button
          type="button"
          className="floating-extension-window-recovery"
          style={{ zIndex: zIndex + 1000, top: 12 + Math.min(offset, 4) * 44 }}
          onClick={recoverWindow}
          title={`找回“${request.title}”`}
        >
          <Move size={16} aria-hidden="true" />
          <span>找回浮窗</span>
        </button>
      )}
    </>
  );
}
