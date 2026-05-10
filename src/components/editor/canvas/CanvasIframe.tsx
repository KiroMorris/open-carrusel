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
import { rafThrottle } from "@/lib/throttle";
import { runOverridesDiff } from "./canvasOverridesDiff";
import type { AspectRatio, CanvasOverrides } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import type {
  IframeToParentMessage,
  ImageFrameInitMessage,
  MeasuredLayer,
  Modifiers,
  ParentToIframeMessage,
  ShapeInitMessage,
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
  /** Phase 3 (canvas-image-frames) — image frame init signal at boot. */
  onImageFrameInit?: (payload: ImageFrameInitMessage["payload"]) => void;
  /** Phase 3 (canvas-image-frames) — shape init signal at boot. */
  onShapeInit?: (payload: ShapeInitMessage["payload"]) => void;
  /** Phase 4 (canvas-image-frames) — image pan from inside-frame mode. */
  onImagePan?: (payload: import("@/types/canvas").ImagePanMessage["payload"]) => void;
  /** Phase 4 (canvas-image-frames) — image zoom from inside-frame mode. */
  onImageZoom?: (payload: import("@/types/canvas").ImageZoomMessage["payload"]) => void;
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
  onImageFrameInit,
  onShapeInit,
  onImagePan,
  onImageZoom,
  sendRef,
  onAnyMessage,
}: CanvasIframeProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [isReady, setIsReady] = useState(false);
  const { width: slideW, height: slideH } = DIMENSIONS[aspectRatio];

  // BUG-002 fix: treat `overrides` as a side-channel.
  //
  // Putting `overrides` in `srcDoc`'s memo deps caused the iframe to be
  // assigned a fresh `srcDoc` on every drag tick / Inspector tweak, which
  // made the browser tear down and reboot the iframe — wiping caret state,
  // selection, in-flight pointer drags, and the runtime's layout cache.
  //
  // We now bake `overrides` into the FIRST srcDoc only (so initial paint
  // is consistent), then push subsequent changes through postMessage so
  // the live runtime can mutate the DOM in place without a reboot.
  const initialOverridesRef = useRef<CanvasOverrides | null>(overrides ?? null);
  const srcDoc = useMemo(
    () =>
      wrapSlideHtml(html, aspectRatio, {
        overrides: initialOverridesRef.current,
        editorRuntime: true,
      }),
    // `overrides` intentionally omitted — see comment above.
    [html, aspectRatio]
  );

  // When the slide swaps (new html / aspectRatio), reset the baseline so
  // the next srcDoc bakes in the current overrides for first paint.
  useEffect(() => {
    initialOverridesRef.current = overrides ?? null;
    // We deliberately omit `overrides` from deps: this only runs on slide
    // swap, not when overrides mutate during editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, aspectRatio]);

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

  // Track the last overrides snapshot we synced into the iframe so we can
  // diff and only ship changed/added/removed layers on each render.
  const lastSentRef = useRef<CanvasOverrides | null>(initialOverridesRef.current);

  // When the slide HTML/ratio changes, the new srcDoc has already been
  // re-baked with the current `initialOverridesRef.current`, so the runtime
  // boots with that as its baseline. Resync `lastSentRef` to that baseline
  // so the diffing effect doesn't immediately try to re-send everything (or
  // worse, "delete" layers from the previous slide).
  useEffect(() => {
    lastSentRef.current = initialOverridesRef.current;
    setIsReady(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, aspectRatio]);

  // Live overrides → postMessage diff sync. Only runs once the runtime has
  // signaled `oc:editor:ready`.
  //
  // Phase 6 — wrap the diff dispatch in `rafThrottle` so high-frequency
  // override mutations during pan/zoom don't blow up the postMessage channel.
  // We collapse to one batch per animation frame (~60Hz). Latest-args wins:
  // the throttled function reads `overrides` from `overridesRef` so a flurry
  // of mutations within one frame produces exactly one diff against the
  // most-recent snapshot.
  const overridesRef = useRef<CanvasOverrides | null>(overrides ?? null);
  useEffect(() => {
    overridesRef.current = overrides ?? null;
  }, [overrides]);

  const isReadyRef = useRef(false);

  const flushDiff = useMemo(
    () =>
      rafThrottle(() => {
        if (!isReadyRef.current) return;
        const next = overridesRef.current;
        const prev = lastSentRef.current;
        runOverridesDiff(next, prev, send);
        lastSentRef.current = next;
      }),
    // `send` is stable (useCanvasSender memoizes); deliberately omit from
    // deps so we don't recreate the throttle on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Cancel any pending RAF on unmount.
  useEffect(() => () => flushDiff.cancel(), [flushDiff]);

  useEffect(() => {
    isReadyRef.current = isReady;
    // When the iframe just became ready, kick a flush so the runtime sees
    // any overrides that piled up during boot.
    if (isReady) flushDiff();
  }, [isReady, flushDiff]);

  // Schedule a flush on every overrides mutation; the RAF throttle collapses
  // bursts to at most one diff per animation frame.
  useEffect(() => {
    if (!isReady) return;
    flushDiff();
  }, [overrides, isReady, flushDiff]);

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
      onReady: (payload) => {
        // Flip the local readiness flag so the overrides-diff effect can
        // start streaming live updates via postMessage.
        setIsReady(true);
        onReady?.(payload);
      },
      onLayout,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onDoubleClickText,
      onTextEdit,
      onImageFrameInit,
      onShapeInit,
      onImagePan,
      onImageZoom,
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
    onImageFrameInit,
    onShapeInit,
    onImagePan,
    onImageZoom,
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

