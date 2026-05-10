"use client";

/**
 * SelectionOverlay — SVG drawn ABOVE the editor iframe, in PARENT space.
 *
 * Coordinate spaces (Phase 2's landmine #1):
 *   - Layer transforms (`x,y,w,h`) are in SLIDE coords (1080×1350-ish).
 *   - The iframe is rendered in the parent at `transform: scale(s)`.
 *   - The SVG sits in parent space at the SAME width/height as the scaled
 *     iframe wrapper (so 1 SVG px = 1 parent px). To draw a slide-coord
 *     bounding box we multiply by `scale`. To translate parent pointer
 *     events back into slide deltas, we divide by `scale`.
 *
 * The overlay is `pointerEvents: 'none'` for empty space (so the iframe
 * underneath receives mousedowns to start a drag/select) and `'auto'` on
 * the resize/rotation handles (so the parent owns those drags directly).
 */

import { useEffect, useMemo, useRef } from "react";
import type { FrameTransform, LayerTransform } from "@/types/carousel";
import type { SnapGuide } from "./useSnap";

export type HandleId =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "rotate";

/**
 * Phase 3 (canvas-image-frames). The active selection kind drives the visual
 * style + handle behavior:
 *   - "text" — original text-layer dashed yellow outline + 8 handles + rotate.
 *   - "image-frame" / "shape" (frame mode) — same dashed yellow outline + 8
 *     handles + rotate; resize math is identical, kind is forwarded back to
 *     the parent in `OverlayDragStart` so the parent dispatches to the right
 *     mutator.
 *   - "image-frame" (inside-frame mode) — solid blue 4px outline, NO handles.
 *     Phase 4 wires this; Phase 3 leaves the visual code path implemented but
 *     "inside-frame" is never set yet.
 */
export type SelectionKind =
  | "text"
  | "image-frame"
  | "shape"
  | "image-frame-inside";

export interface OverlayDragStart {
  kind: "handle";
  handle: HandleId;
  /** What kind of layer is being resized — drives parent dispatch. */
  selectionKind: SelectionKind;
  /** Snapshot of the layer's transform/frame at drag-start. */
  startTransform: LayerTransform;
  pointerSlideX: number;
  pointerSlideY: number;
  shift: boolean;
  alt: boolean;
}

export interface MarqueeRect {
  /** All in slide coords. */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SelectionOverlayProps {
  /** PRIMARY selected layer (the one with handles). Null = no selection.
   *  For text layers this is `layer.transform`; for image-frame / shape
   *  it is the FrameTransform (same shape, different storage). */
  transform: LayerTransform | null;
  /** Phase 3 (canvas-image-frames) — what kind of layer is selected.
   *  Defaults to "text" for backward compat with existing call sites. */
  kind?: SelectionKind;
  /** Phase 4 — bounding boxes for ALL selected layers. Each gets a dashed
   *  outline. The primary layer gets handles in addition. Slide coords. */
  selectionBoxes?: LayerTransform[];
  /** Phase 4 — snap guide lines to draw during drag. Slide coords. */
  guides?: SnapGuide[];
  /** Phase 4 — marquee rectangle during marquee selection. Slide coords. */
  marquee?: MarqueeRect | null;
  /** Iframe→parent scale factor (parent_px / slide_px). */
  scale: number;
  /** Slide intrinsic width/height in slide coords. */
  slideW: number;
  slideH: number;
  /** Called when the user starts dragging on a resize/rotate handle. */
  onHandleDown: (info: OverlayDragStart, ev: React.PointerEvent) => void;
}

/**
 * Convenience: convert a FrameTransform (image-frame/shape) into the
 * LayerTransform shape expected by SelectionOverlay's `transform` prop. The
 * two are structurally identical for SVG drawing purposes; this exists so
 * call sites read clearly.
 */
export function frameToOverlayTransform(frame: FrameTransform): LayerTransform {
  return {
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
    rotation: frame.rotation,
    z: frame.z,
  };
}

const HANDLE_SIZE = 10; // px in PARENT space
const ROTATE_OFFSET = 30;

export function SelectionOverlay({
  transform,
  kind = "text",
  selectionBoxes,
  guides,
  marquee,
  scale,
  slideW,
  slideH,
  onHandleDown,
}: SelectionOverlayProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Width/height of the overlay in PARENT space (matches the scaled iframe).
  const wPx = slideW * scale;
  const hPx = slideH * scale;

  const box = useMemo(() => {
    if (!transform) return null;
    const x = transform.x * scale;
    const y = transform.y * scale;
    const w = transform.w * scale;
    const h = transform.h * scale;
    return { x, y, w, h, rot: transform.rotation };
  }, [transform, scale]);

  // Wrap the user's onHandleDown so we can capture & convert event coords
  // into slide-space here (the consumer doesn't need to know about scale).
  const startHandleDrag = (handle: HandleId, ev: React.PointerEvent) => {
    if (!transform || !svgRef.current) return;
    ev.preventDefault();
    ev.stopPropagation();
    const rect = svgRef.current.getBoundingClientRect();
    const slideX = (ev.clientX - rect.left) / scale;
    const slideY = (ev.clientY - rect.top) / scale;
    onHandleDown(
      {
        kind: "handle",
        handle,
        selectionKind: kind,
        startTransform: { ...transform },
        pointerSlideX: slideX,
        pointerSlideY: slideY,
        shift: ev.shiftKey,
        alt: ev.altKey,
      },
      ev
    );
  };

  // Suppress native drag-image/text-select while interacting on overlay.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const noop = (e: Event) => e.preventDefault();
    svg.addEventListener("dragstart", noop);
    return () => svg.removeEventListener("dragstart", noop);
  }, []);

  return (
    <svg
      ref={svgRef}
      width={wPx}
      height={hPx}
      viewBox={`0 0 ${wPx} ${hPx}`}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: wPx,
        height: hPx,
        // Click-through by default; handles below opt back in.
        pointerEvents: "none",
        // Above iframe.
        zIndex: 5,
        userSelect: "none",
      }}
    >
      {/* Secondary selection outlines (multi-select, no handles). */}
      {selectionBoxes && selectionBoxes.length > 1 &&
        selectionBoxes
          .filter((t) => !transform || t.x !== transform.x || t.y !== transform.y || t.w !== transform.w || t.h !== transform.h)
          .map((t, i) => {
            const cx = (t.x + t.w / 2) * scale;
            const cy = (t.y + t.h / 2) * scale;
            return (
              <g
                key={`sel-${i}`}
                transform={t.rotation ? `rotate(${t.rotation} ${cx} ${cy})` : undefined}
              >
                <rect
                  x={t.x * scale}
                  y={t.y * scale}
                  width={t.w * scale}
                  height={t.h * scale}
                  fill="none"
                  stroke="var(--accent, #1A4231)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  style={{ pointerEvents: "none" }}
                />
              </g>
            );
          })}

      {/* Snap guides (Phase 4). */}
      {guides && guides.length > 0 &&
        guides.map((g, i) => {
          if (g.orientation === "v") {
            const x = g.position * scale;
            return (
              <line
                key={`g-${i}`}
                x1={x}
                x2={x}
                y1={g.from * scale}
                y2={g.to * scale}
                stroke="var(--brand-yellow, #F4B400)"
                strokeWidth={1}
                style={{ pointerEvents: "none" }}
              />
            );
          }
          const y = g.position * scale;
          return (
            <line
              key={`g-${i}`}
              x1={g.from * scale}
              x2={g.to * scale}
              y1={y}
              y2={y}
              stroke="var(--brand-yellow, #F4B400)"
              strokeWidth={1}
              style={{ pointerEvents: "none" }}
            />
          );
        })}

      {/* Marquee (Phase 4). */}
      {marquee && (
        <rect
          x={marquee.x * scale}
          y={marquee.y * scale}
          width={marquee.w * scale}
          height={marquee.h * scale}
          fill="var(--brand-yellow, #F4B400)"
          fillOpacity={0.08}
          stroke="var(--brand-yellow, #F4B400)"
          strokeWidth={1}
          strokeDasharray="3 2"
          style={{ pointerEvents: "none" }}
        />
      )}

      {box && kind === "image-frame-inside" ? (
        <InsideFrameSelection box={box} />
      ) : box ? (
        <Selection box={box} onHandleDown={startHandleDrag} />
      ) : null}
    </svg>
  );
}

/**
 * Phase 4 visual: solid blue 4px outline, no handles. Drawn while the user
 * is panning/zooming inside an image frame. Phase 3 implements the rendering
 * but never sets `kind: "image-frame-inside"`.
 */
function InsideFrameSelection({
  box,
}: {
  box: { x: number; y: number; w: number; h: number; rot: number };
}) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return (
    <g transform={box.rot ? `rotate(${box.rot} ${cx} ${cy})` : undefined}>
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        fill="none"
        stroke="#3B82F6"
        strokeWidth={4}
        style={{ pointerEvents: "none" }}
      />
    </g>
  );
}

function Selection({
  box,
  onHandleDown,
}: {
  box: { x: number; y: number; w: number; h: number; rot: number };
  onHandleDown: (handle: HandleId, ev: React.PointerEvent) => void;
}) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const handles: Array<{ id: HandleId; x: number; y: number; cursor: string }> = [
    { id: "nw", x: box.x, y: box.y, cursor: "nwse-resize" },
    { id: "n", x: cx, y: box.y, cursor: "ns-resize" },
    { id: "ne", x: box.x + box.w, y: box.y, cursor: "nesw-resize" },
    { id: "e", x: box.x + box.w, y: cy, cursor: "ew-resize" },
    { id: "se", x: box.x + box.w, y: box.y + box.h, cursor: "nwse-resize" },
    { id: "s", x: cx, y: box.y + box.h, cursor: "ns-resize" },
    { id: "sw", x: box.x, y: box.y + box.h, cursor: "nesw-resize" },
    { id: "w", x: box.x, y: cy, cursor: "ew-resize" },
  ];

  // Rotation handle: 30 px above the top-center handle, in unrotated space.
  const rotateHandle = { id: "rotate" as HandleId, x: cx, y: box.y - ROTATE_OFFSET };

  return (
    <g transform={box.rot ? `rotate(${box.rot} ${cx} ${cy})` : undefined}>
      {/* Selection outline */}
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        fill="none"
        stroke="var(--brand-yellow, #F4B400)"
        strokeWidth={1}
        strokeDasharray="4 3"
        style={{ pointerEvents: "none" }}
      />
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        fill="none"
        stroke="var(--brand-green, #1A4231)"
        strokeWidth={1}
        strokeDasharray="4 3"
        strokeDashoffset={3}
        style={{ pointerEvents: "none" }}
      />

      {/* Rotation arm + handle */}
      <line
        x1={cx}
        y1={box.y}
        x2={rotateHandle.x}
        y2={rotateHandle.y}
        stroke="var(--brand-green, #1A4231)"
        strokeWidth={1}
        style={{ pointerEvents: "none" }}
      />
      <circle
        cx={rotateHandle.x}
        cy={rotateHandle.y}
        r={HANDLE_SIZE / 2 + 1}
        fill="var(--brand-yellow, #F4B400)"
        stroke="var(--brand-green, #1A4231)"
        strokeWidth={1}
        style={{ pointerEvents: "auto", cursor: "grab" }}
        onPointerDown={(e) => onHandleDown("rotate", e)}
      />

      {/* 8 resize handles */}
      {handles.map((h) => (
        <rect
          key={h.id}
          x={h.x - HANDLE_SIZE / 2}
          y={h.y - HANDLE_SIZE / 2}
          width={HANDLE_SIZE}
          height={HANDLE_SIZE}
          fill="white"
          stroke="var(--brand-green, #1A4231)"
          strokeWidth={1}
          style={{ pointerEvents: "auto", cursor: h.cursor }}
          onPointerDown={(e) => onHandleDown(h.id, e)}
        />
      ))}
    </g>
  );
}
