"use client";

/**
 * CanvasIframe — the relaxed-sandbox iframe that hosts the editor runtime.
 *
 * Mirrors `SlideRenderer`'s scaling/wrapping but with two differences:
 *   1. `sandbox="allow-scripts allow-same-origin"` so the editor runtime
 *      can run.
 *   2. `pointerEvents` is left ON for the iframe — pointer events get
 *      handled by the runtime inside.
 *
 * Phase 2 responsibility:
 *   - Render the iframe with `wrapSlideHtml({ overrides, editorRuntime: true })`.
 *   - Listen for runtime → parent messages and dispatch to props callbacks.
 *   - Expose an imperative `send` ref so the parent can push selection /
 *     transform messages back into the iframe (Phase 3+ will use this).
 *
 * Phase 3 will add the SelectionOverlay sibling that draws handles over
 * this iframe and translates parent pointer coords to slide coords.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { wrapSlideHtml } from "@/lib/slide-html";
import type { AspectRatio, CanvasOverrides } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import type {
  IframeToParentMessage,
  MeasuredLayer,
  Modifiers,
  ParentToIframeMessage,
} from "@/types/canvas";
import { installCanvasListener, useCanvasSender } from "./useCanvasMessages";

export interface CanvasIframeProps {
  html: string;
  aspectRatio: AspectRatio;
  overrides?: CanvasOverrides | null;
  className?: string;
  style?: React.CSSProperties;
  onReady?: (payload: { slideW: number; slideH: number }) => void;
  onLayout?: (payload: { layers: MeasuredLayer[] }) => void;
  onPointerDown?: (payload: {
    id: string | null;
    clientX: number;
    clientY: number;
    modifiers: Modifiers;
  }) => void;
  onPointerMove?: (payload: {
    deltaX: number;
    deltaY: number;
    clientX: number;
    clientY: number;
    modifiers: Modifiers;
  }) => void;
  onPointerUp?: () => void;
  onDoubleClickText?: (payload: { id: string }) => void;
  /** Phase 4 — emitted on contenteditable blur after inline-edit. */
  onTextEdit?: (payload: { id: string; text: string }) => void;
  /** Imperative handle for parent → iframe sends. */
  sendRef?: MutableRefObject<((msg: ParentToIframeMessage) => void) | null>;
  /** Optional debug tap — sees every validated message. */
  onAnyMessage?: (msg: IframeToParentMessage) => void;
}

export function CanvasIframe({
  html,
  aspectRatio,
  overrides,
  className,
  style,
  onReady,
  onLayout,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onDoubleClickText,
  onTextEdit,
  sendRef,
  onAnyMessage,
}: CanvasIframeProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const { width: slideW, height: slideH } = DIMENSIONS[aspectRatio];

  // Re-render the iframe content when html / ratio / overrides change.
  // Note: changing srcDoc tears down the runtime and reinstalls it on the
  // next ready handshake — that's correct for Phase 2; Phase 3 may want a
  // patch-only path to preserve selection across overrides updates.
  const srcDoc = useMemo(
    () =>
      wrapSlideHtml(html, aspectRatio, {
        overrides: overrides ?? null,
        editorRuntime: true,
      }),
    [html, aspectRatio, overrides]
  );

  // Stable sender function.
  const send = useCanvasSender(iframeRef);

  // Expose `send` via imperative ref so parent components (Phase 3
  // SelectionOverlay etc.) can push selection / transform messages back.
  useEffect(() => {
    if (sendRef) sendRef.current = send;
    return () => {
      if (sendRef) sendRef.current = null;
    };
  }, [send, sendRef]);

  // Measure outer container for scale-to-fit.
  const measure = useCallback(() => {
    const el = outerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setDims({ w: rect.width, h: rect.height });
    }
  }, []);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => measure());
    obs.observe(el);
    measure();
    return () => obs.disconnect();
  }, [measure]);

  // Wire the typed message listener whenever the iframe element is mounted.
  // We re-attach on srcDoc change because the iframe is the same element
  // but the runtime inside is new — the listener doesn't care, but we want
  // to make sure stale handlers from a previous render aren't held.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const teardown = installCanvasListener(iframe, {
      onReady,
      onLayout,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onDoubleClickText,
      onTextEdit,
      onAny: onAnyMessage,
    });
    return teardown;
  }, [
    srcDoc,
    onReady,
    onLayout,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClickText,
    onTextEdit,
    onAnyMessage,
  ]);

  const scale = dims ? Math.min(dims.w / slideW, dims.h / slideH) : 0;
  const scaledW = Math.floor(slideW * scale);
  const scaledH = Math.floor(slideH * scale);

  return (
    <div
      ref={outerRef}
      className={className}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      {scale > 0 && (
        <div
          style={{
            width: scaledW,
            height: scaledH,
            overflow: "hidden",
            borderRadius: 8,
            position: "relative",
            boxShadow: "0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)",
            border: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          <iframe
            ref={iframeRef}
            // Relaxed sandbox so the editor runtime can run. The runtime is
            // the only <script> we ever inject (defended in `wrapSlideHtml`),
            // and the slide HTML is server-stripped of <script> tags.
            sandbox="allow-scripts allow-same-origin"
            srcDoc={srcDoc}
            title="Canvas editor (refine mode)"
            style={{
              width: slideW,
              height: slideH,
              border: "none",
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              position: "absolute",
              top: 0,
              left: 0,
              // Pointer events ON — the runtime needs them.
              pointerEvents: "auto",
            }}
          />
        </div>
      )}
    </div>
  );
}
