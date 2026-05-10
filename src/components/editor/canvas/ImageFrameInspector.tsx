"use client";

/**
 * ImageFrameInspector — right-side panel shown when the selected canvas item
 * is an image-frame OR a shape.
 *
 * Phase 3 shipped frame-mode controls (position / size / rotation / reset).
 * Phase 4 (this file's current state) enables the "Image inside" segment of
 * the mode toggle and adds inside-frame controls (scale slider, tx/ty
 * readouts, "Reset image position" button).
 *
 * Pure-presentational: parent owns the override store and supplies callbacks.
 */

import { Image as ImageIcon, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  FrameTransform,
  ImageInnerTransform,
  ImageOverride,
  ShapeOverride,
} from "@/types/carousel";

export type SelectedFrameItem =
  | { kind: "image-frame"; image: ImageOverride; sourceSrc?: string | null }
  | { kind: "shape"; shape: ShapeOverride };

interface ImageFrameInspectorProps {
  selected: SelectedFrameItem;
  /** Apply a frame partial. `commit` lets caller persist immediately. */
  onFrameChange: (frame: Partial<FrameTransform>) => void;
  /** Reset (delete) the override for this id, reverting to natural rect. */
  onResetFrame: () => void;
  /** Phase 4 (canvas-image-frames). Current mode of the selected image
   *  frame; null/"frame" → frame-mode controls; "inside-frame" → inside
   *  controls (scale slider, image translate readouts). Ignored for
   *  shapes (which only ever have one mode). */
  mode?: "frame" | "inside-frame" | null;
  /** Phase 4. Toggle frame ↔ inside-frame mode. Wired only for image-frame
   *  selections. */
  onModeChange?: (mode: "frame" | "inside-frame") => void;
  /** Phase 4. Apply an image-inner partial (scale / tx / ty). Caller
   *  re-clamps to cover invariant. */
  onImageChange?: (image: Partial<ImageInnerTransform>) => void;
  /** Phase 4. Reset image-inner to its initial cover-fit calibration. */
  onResetImagePosition?: () => void;
  className?: string;
}

export function ImageFrameInspector({
  selected,
  onFrameChange,
  onResetFrame,
  mode,
  onModeChange,
  onImageChange,
  onResetImagePosition,
  className,
}: ImageFrameInspectorProps) {
  const frame =
    selected.kind === "image-frame" ? selected.image.frame : selected.shape.frame;
  const naturalRect =
    selected.kind === "image-frame"
      ? selected.image.naturalFrameRect
      : selected.shape.naturalRect;
  const id =
    selected.kind === "image-frame" ? selected.image.id : selected.shape.id;
  const Icon = selected.kind === "image-frame" ? ImageIcon : Square;
  const label = selected.kind === "image-frame" ? "Image frame" : "Shape";
  const sourceSrc =
    selected.kind === "image-frame" ? selected.sourceSrc ?? null : null;
  const isImageFrame = selected.kind === "image-frame";
  const isInside = isImageFrame && mode === "inside-frame";
  const imageInner = isImageFrame ? selected.image.image : null;
  const natural = isImageFrame ? selected.image.natural : null;
  // minScale is the "cover" floor — image must always fully cover the frame.
  const minScale =
    isImageFrame && natural && natural.w > 0 && natural.h > 0
      ? Math.max(frame.w / natural.w, frame.h / natural.h)
      : 0.1;

  const upd = (patch: Partial<FrameTransform>) => onFrameChange(patch);

  const handleReset = () => {
    if (
      window.confirm(
        `Reset this ${label.toLowerCase()} to its original position and size?`
      )
    ) {
      onResetFrame();
    }
  };

  return (
    <div className={cn("flex flex-col text-xs", className)}>
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        <span className="h-5 w-5 rounded bg-muted text-muted-foreground flex items-center justify-center shrink-0">
          <Icon className="h-3 w-3" />
        </span>
        <div className="flex flex-col min-w-0">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
            {label}
          </span>
          <span
            className="text-[10px] text-muted-foreground truncate font-mono"
            title={id}
          >
            {id}
          </span>
        </div>
      </div>

      {/* Phase 4 (canvas-image-frames). Mode segmented control — both
          segments wire actual mode changes. */}
      {isImageFrame && (
        <div className="px-3 py-2 border-b border-border">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            Mode
          </div>
          <div className="flex h-7 rounded border border-border bg-background overflow-hidden">
            <button
              type="button"
              onClick={() => onModeChange?.("frame")}
              className={cn(
                "flex-1 text-[11px] uppercase tracking-wide transition-colors",
                !isInside
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted text-muted-foreground"
              )}
              aria-pressed={!isInside}
              title="Frame mode (drag/resize/rotate)"
            >
              Frame
            </button>
            <button
              type="button"
              onClick={() => onModeChange?.("inside-frame")}
              className={cn(
                "flex-1 text-[11px] uppercase tracking-wide border-l border-border transition-colors",
                isInside
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted text-muted-foreground"
              )}
              aria-pressed={isInside}
              title="Inside-frame mode (pan/zoom)"
            >
              Image inside
            </button>
          </div>
        </div>
      )}

      {/* Optional thumbnail for image-frame */}
      {sourceSrc && (
        <div className="px-3 py-2 border-b border-border">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            Source
          </div>
          <div
            className="h-20 w-full rounded border border-border bg-muted overflow-hidden flex items-center justify-center"
            title={sourceSrc}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sourceSrc}
              alt="Frame source"
              className="max-h-full max-w-full object-contain"
              draggable={false}
            />
          </div>
        </div>
      )}

      <div className="p-3 space-y-3">
        {isInside && imageInner ? (
          <>
            {/* Phase 4 — inside-frame controls. */}
            <Field label={`Scale (${imageInner.scale.toFixed(2)}x)`}>
              <input
                type="range"
                min={minScale}
                max={8}
                step={0.01}
                value={imageInner.scale}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!isNaN(v)) onImageChange?.({ scale: v });
                }}
                className="w-full"
              />
            </Field>

            <Field label="Image position">
              <div className="grid grid-cols-2 gap-2">
                <NumberInput
                  value={imageInner.tx}
                  onChange={(v) => onImageChange?.({ tx: v })}
                  prefix="tx"
                />
                <NumberInput
                  value={imageInner.ty}
                  onChange={(v) => onImageChange?.({ ty: v })}
                  prefix="ty"
                />
              </div>
            </Field>

            <button
              type="button"
              onClick={() => onResetImagePosition?.()}
              className="w-full text-[10px] uppercase tracking-wider px-2 py-1.5 rounded border border-border hover:border-accent hover:text-accent transition-colors"
              title="Restore initial cover-fit (centered, no zoom)"
            >
              Reset image position
            </button>

            <div className="pt-2 mt-2 border-t border-border text-[10px] text-muted-foreground space-y-0.5">
              <div>Drag inside the frame to pan.</div>
              <div>Scroll wheel zooms (cursor-anchored).</div>
              <div>Press Esc to exit.</div>
            </div>
          </>
        ) : (
          <>
            <Field label="Position">
              <div className="grid grid-cols-2 gap-2">
                <NumberInput
                  value={frame.x}
                  onChange={(v) => upd({ x: v })}
                  prefix="x"
                />
                <NumberInput
                  value={frame.y}
                  onChange={(v) => upd({ y: v })}
                  prefix="y"
                />
              </div>
            </Field>

            <Field label="Size">
              <div className="grid grid-cols-2 gap-2">
                <NumberInput
                  value={frame.w}
                  onChange={(v) => upd({ w: Math.max(8, v) })}
                  prefix="w"
                  min={8}
                />
                <NumberInput
                  value={frame.h}
                  onChange={(v) => upd({ h: Math.max(8, v) })}
                  prefix="h"
                  min={8}
                />
              </div>
            </Field>

            <Field label="Rotation (°)">
              <NumberInput
                value={frame.rotation}
                onChange={(v) => upd({ rotation: v })}
                step={1}
              />
            </Field>

            <div className="pt-2 mt-2 border-t border-border">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Natural rect (Claude&rsquo;s layout)
              </div>
              <div className="font-mono text-[10px] text-muted-foreground space-y-0.5">
                <div>
                  x {Math.round(naturalRect.x)}, y {Math.round(naturalRect.y)}
                </div>
                <div>
                  w {Math.round(naturalRect.w)} × h {Math.round(naturalRect.h)}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleReset}
              className="w-full mt-2 text-[10px] uppercase tracking-wider px-2 py-1.5 rounded border border-border hover:border-destructive hover:text-destructive transition-colors"
              title="Discard this frame override and return to original"
            >
              Reset frame
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        {label}
      </div>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  prefix,
  min,
  step = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  min?: number;
  step?: number;
}) {
  return (
    <div className="flex items-center h-7 border border-border rounded bg-background overflow-hidden">
      {prefix && (
        <span className="px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground border-r border-border bg-muted/40">
          {prefix}
        </span>
      )}
      <input
        type="number"
        value={Math.round(value * 10) / 10}
        step={step}
        min={min}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(v);
        }}
        className="flex-1 px-1.5 text-xs bg-transparent outline-none w-full min-w-0"
      />
    </div>
  );
}
