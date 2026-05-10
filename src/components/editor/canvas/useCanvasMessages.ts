"use client";

/**
 * Typed message-passing helper for the editor iframe ⇄ parent channel.
 *
 * Two pieces:
 *   1. `installCanvasListener(iframe, handlers)` — attaches a window message
 *      listener that validates origin (via `iframe.contentWindow === ev.source`)
 *      and dispatches incoming `IframeToParentMessage` to typed handlers.
 *      Returns a teardown function.
 *   2. `useCanvasSender(iframeRef)` — a React hook that returns a stable
 *      `send(msg: ParentToIframeMessage)` callback. The send function is a
 *      no-op until the iframe's contentWindow is available.
 *
 * Why both, instead of one big hook? Because `CanvasIframe` needs the
 * listener wired *synchronously* with the iframe ref to avoid races, and
 * the sender is owned by the parent component that drives the iframe.
 */

import { useCallback, useEffect, useRef } from "react";
import type {
  IframeToParentMessage,
  ParentToIframeMessage,
} from "@/types/canvas";

export interface CanvasIframeHandlers {
  onReady?: (
    payload: Extract<IframeToParentMessage, { type: "oc:editor:ready" }>["payload"]
  ) => void;
  onLayout?: (
    payload: Extract<IframeToParentMessage, { type: "oc:editor:layout" }>["payload"]
  ) => void;
  onPointerDown?: (
    payload: Extract<
      IframeToParentMessage,
      { type: "oc:editor:pointer-down" }
    >["payload"]
  ) => void;
  onPointerMove?: (
    payload: Extract<
      IframeToParentMessage,
      { type: "oc:editor:pointer-move" }
    >["payload"]
  ) => void;
  onPointerUp?: () => void;
  onDoubleClickText?: (
    payload: Extract<
      IframeToParentMessage,
      { type: "oc:editor:dblclick-text" }
    >["payload"]
  ) => void;
  onTextEdit?: (
    payload: Extract<
      IframeToParentMessage,
      { type: "oc:editor:text-edit" }
    >["payload"]
  ) => void;
  // Phase 2 — image/shape init signals from the runtime.
  onImageFrameInit?: (
    payload: Extract<
      IframeToParentMessage,
      { type: "oc:editor:image-frame-init" }
    >["payload"]
  ) => void;
  onShapeInit?: (
    payload: Extract<
      IframeToParentMessage,
      { type: "oc:editor:shape-init" }
    >["payload"]
  ) => void;
  // Phase 4 territory — defined now so the listener acks them silently
  // instead of dropping them on the floor.
  onImagePan?: (
    payload: Extract<
      IframeToParentMessage,
      { type: "oc:editor:image-pan" }
    >["payload"]
  ) => void;
  onImageZoom?: (
    payload: Extract<
      IframeToParentMessage,
      { type: "oc:editor:image-zoom" }
    >["payload"]
  ) => void;
  /** Called for every validated message — handy for harness logging. */
  onAny?: (msg: IframeToParentMessage) => void;
}

const ALL_TYPES = new Set<IframeToParentMessage["type"]>([
  "oc:editor:ready",
  "oc:editor:layout",
  "oc:editor:pointer-down",
  "oc:editor:pointer-move",
  "oc:editor:pointer-up",
  "oc:editor:dblclick-text",
  "oc:editor:text-edit",
  "oc:editor:image-frame-init",
  "oc:editor:shape-init",
  "oc:editor:image-pan",
  "oc:editor:image-zoom",
]);

/**
 * Attach a typed message listener for the given iframe. Validates origin via
 * `iframe.contentWindow === ev.source` (the only origin check that survives
 * `srcDoc` + sandbox null-origin nullification). Returns a teardown fn.
 */
export function installCanvasListener(
  iframe: HTMLIFrameElement,
  handlers: CanvasIframeHandlers
): () => void {
  const onMessage = (ev: MessageEvent) => {
    // Origin guard: only accept messages from this iframe's contentWindow.
    if (!iframe.contentWindow || ev.source !== iframe.contentWindow) return;
    const data = ev.data;
    if (!data || typeof data !== "object") return;
    const type = (data as { type?: string }).type;
    if (!type || !ALL_TYPES.has(type as IframeToParentMessage["type"])) return;
    const msg = data as IframeToParentMessage;
    handlers.onAny?.(msg);
    switch (msg.type) {
      case "oc:editor:ready":
        handlers.onReady?.(msg.payload);
        break;
      case "oc:editor:layout":
        handlers.onLayout?.(msg.payload);
        break;
      case "oc:editor:pointer-down":
        handlers.onPointerDown?.(msg.payload);
        break;
      case "oc:editor:pointer-move":
        handlers.onPointerMove?.(msg.payload);
        break;
      case "oc:editor:pointer-up":
        handlers.onPointerUp?.();
        break;
      case "oc:editor:dblclick-text":
        handlers.onDoubleClickText?.(msg.payload);
        break;
      case "oc:editor:text-edit":
        handlers.onTextEdit?.(msg.payload);
        break;
      case "oc:editor:image-frame-init":
        handlers.onImageFrameInit?.(msg.payload);
        break;
      case "oc:editor:shape-init":
        handlers.onShapeInit?.(msg.payload);
        break;
      case "oc:editor:image-pan":
        handlers.onImagePan?.(msg.payload);
        break;
      case "oc:editor:image-zoom":
        handlers.onImageZoom?.(msg.payload);
        break;
    }
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/**
 * Returns a stable `send` function that posts a typed parent→iframe message.
 *
 * Defensive: if the iframe hasn't loaded yet (or has been unmounted), the
 * message is silently dropped — the parent should always wait for `onReady`
 * before sending non-init messages, but if a stray send sneaks through we
 * don't want to throw inside a render cycle.
 *
 * `targetOrigin` is `*` because srcDoc + sandbox null the origin to "null"
 * and a string-literal targetOrigin would silently fail. The iframe is
 * fully isolated by the sandbox attribute and we control the only injected
 * script.
 */
export function useCanvasSender(
  iframeRef: React.RefObject<HTMLIFrameElement | null>
): (msg: ParentToIframeMessage) => void {
  const queueRef = useRef<ParentToIframeMessage[]>([]);
  const readyRef = useRef(false);

  // Best-effort: also flush any messages the parent queued before the
  // iframe's contentWindow was available.
  useEffect(() => {
    return () => {
      queueRef.current = [];
      readyRef.current = false;
    };
  }, []);

  return useCallback(
    (msg: ParentToIframeMessage) => {
      const iframe = iframeRef.current;
      if (!iframe || !iframe.contentWindow) {
        queueRef.current.push(msg);
        return;
      }
      // Drain queued messages first so order is preserved.
      if (queueRef.current.length) {
        const queued = queueRef.current;
        queueRef.current = [];
        for (const q of queued) {
          try {
            iframe.contentWindow.postMessage(q, "*");
          } catch {
            // Iframe gone away mid-send — drop the rest.
            return;
          }
        }
      }
      try {
        iframe.contentWindow.postMessage(msg, "*");
      } catch {
        // Cross-origin or detached — silently drop.
      }
    },
    [iframeRef]
  );
}
