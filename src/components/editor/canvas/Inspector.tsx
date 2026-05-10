"use client";

/**
 * Inspector — right-side style/text panel for the currently selected layer.
 *
 * Phase 3 controls: font family, font size, weight, italic toggle, color,
 * alignment (left/center/right/justify), line-height, letter-spacing.
 *
 * Each change is reported via `onStyleChange(partial)`. The parent owns the
 * style state, applies it both to the runtime (live preview) and to the
 * persisted overrides (debounced save).
 */

import { useState } from "react";
import {
  AlignCenter,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  Italic,
  Minus,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasLayer, LayerStyle } from "@/types/carousel";
import { LayersPanel, type ZDirection } from "./LayersPanel";

export type AlignKind =
  | "left"
  | "h-center"
  | "right"
  | "top"
  | "v-center"
  | "bottom"
  | "distribute-h"
  | "distribute-v";

const FONT_FAMILIES = [
  "Inter",
  "Prompt",
  "Bagel Fat One",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Playfair Display",
  "Merriweather",
  "Oswald",
  "Raleway",
  "Nunito",
  "PT Sans",
  "Source Sans 3",
  "Bebas Neue",
  "Anton",
  "Archivo",
  "DM Sans",
  "Space Grotesk",
];

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

const PALETTE = [
  "#1A4231", // brand green
  "#F4B400", // brand yellow
  "#F5F2EA", // brand cream
  "#0F1F18", // foreground
  "#FFFFFF",
  "#000000",
  "#B23A2C", // destructive
];

interface InspectorProps {
  /** The PRIMARY selected layer (the most recently selected). Drives the
   *  read-only transform readout and acts as the fallback for "shared"
   *  display when only one layer is selected. */
  layer: CanvasLayer | null;
  /** All currently selected layers. When length > 1, controls show "—"
   *  for fields whose values differ. */
  selectedLayers?: CanvasLayer[];
  onStyleChange: (style: Partial<LayerStyle>) => void;
  /** Phase 4 — multi-select align/distribute. Disabled (hidden) when
   *  selection has < 2 layers (for align) or < 3 (for distribute). */
  onAlign?: (kind: AlignKind) => void;
  /** Phase 4 — full layer roster, in render order, for the embedded
   *  LayersPanel. If omitted, the panel is hidden. */
  allLayers?: CanvasLayer[];
  selectedIds?: string[];
  layerLabels?: Record<string, string>;
  onSelectLayer?: (id: string, additive: boolean) => void;
  onDeleteLayer?: (id: string) => void;
  onZOrderLayer?: (id: string, direction: ZDirection) => void;
  /** True when the slide has any persisted overrides — controls whether the
   *  "Reset slide" action is available. */
  hasOverrides?: boolean;
  /** Wipes ALL canvas overrides for this slide and reverts the iframe to
   *  Claude's original HTML. Confirmed via window.confirm before firing. */
  onResetSlide?: () => void;
  className?: string;
}

export function Inspector({
  layer,
  selectedLayers,
  onStyleChange,
  onAlign,
  allLayers,
  selectedIds,
  layerLabels,
  onSelectLayer,
  onDeleteLayer,
  onZOrderLayer,
  hasOverrides,
  onResetSlide,
  className,
}: InspectorProps) {
  const [showSwatches, setShowSwatches] = useState(false);
  const multi = (selectedLayers?.length ?? 0) > 1;
  const sharedStyle = multi ? sharedStyleFor(selectedLayers!) : layer?.style ?? null;

  const handleReset = () => {
    if (!onResetSlide) return;
    if (
      window.confirm(
        "Discard ALL canvas edits on this slide and revert to the original?\n\nThis cannot be undone."
      )
    ) {
      onResetSlide();
    }
  };

  if (!layer) {
    return (
      <aside
        className={cn(
          "w-64 border-l border-border bg-surface flex flex-col shrink-0 overflow-y-auto",
          className
        )}
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Inspector
          </div>
          {hasOverrides && onResetSlide && (
            <button
              type="button"
              onClick={handleReset}
              className="text-[10px] text-muted-foreground hover:text-destructive uppercase tracking-wider px-2 py-0.5 rounded border border-border hover:border-destructive transition-colors"
              title="Discard all canvas edits and revert this slide"
            >
              Reset slide
            </button>
          )}
        </div>
        <div className="p-4 text-xs text-muted-foreground">
          Select a layer to edit its style.
        </div>
        {allLayers && onSelectLayer && onDeleteLayer && onZOrderLayer && (
          <LayersPanel
            layers={allLayers}
            selectedIds={selectedIds ?? []}
            labels={layerLabels}
            onSelect={onSelectLayer}
            onDelete={onDeleteLayer}
            onZOrder={onZOrderLayer}
          />
        )}
      </aside>
    );
  }

  // When multiple selected, the inputs reflect SHARED values. Fields that
  // differ across the selection display empty / "—" placeholder so
  // committing a change broadcasts it to every selected layer.
  const s = (sharedStyle ?? layer.style) as LayerStyle;

  const upd = (patch: Partial<LayerStyle>) => onStyleChange(patch);

  const fontSize = s.fontSize ?? 24;
  const lineHeight = s.lineHeight ?? 1.2;
  const letterSpacing = s.letterSpacing ?? 0;
  const align = s.textAlign ?? "left";

  return (
    <aside
      className={cn(
        "w-64 border-l border-border bg-surface flex flex-col shrink-0 overflow-y-auto",
        className
      )}
    >
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Inspector
            {multi && (
              <span className="ml-2 text-[10px] normal-case font-normal text-accent">
                {selectedLayers!.length} selected
              </span>
            )}
          </div>
          {hasOverrides && onResetSlide && (
            <button
              type="button"
              onClick={handleReset}
              className="text-[10px] text-muted-foreground hover:text-destructive uppercase tracking-wider px-2 py-0.5 rounded border border-border hover:border-destructive transition-colors"
              title="Discard all canvas edits and revert this slide"
            >
              Reset slide
            </button>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5 truncate" title={layer.id}>
          {multi ? `${selectedLayers!.length} layers` : layer.id}
        </div>
      </div>

      {multi && onAlign && (
        <AlignToolbar
          selectionSize={selectedLayers!.length}
          onAlign={onAlign}
        />
      )}

      <div className="p-3 space-y-3 text-xs">
        {/* Font family */}
        <Field label="Font">
          <select
            value={s.fontFamily ?? ""}
            onChange={(e) => upd({ fontFamily: e.target.value || undefined })}
            className="h-7 px-2 border border-border rounded bg-background text-xs w-full"
          >
            <option value="">— inherit —</option>
            {FONT_FAMILIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>

        {/* Font size */}
        <Field label="Size">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => upd({ fontSize: Math.max(8, fontSize - 1) })}
              className="h-7 w-7 border border-border rounded hover:bg-muted flex items-center justify-center"
              aria-label="Decrease size"
            >
              <Minus className="h-3 w-3" />
            </button>
            <input
              type="number"
              min={8}
              max={400}
              value={fontSize}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v)) upd({ fontSize: Math.max(8, Math.min(400, v)) });
              }}
              className="h-7 px-2 border border-border rounded bg-background text-xs w-full"
            />
            <button
              type="button"
              onClick={() => upd({ fontSize: Math.min(400, fontSize + 1) })}
              className="h-7 w-7 border border-border rounded hover:bg-muted flex items-center justify-center"
              aria-label="Increase size"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        </Field>

        {/* Weight + Italic */}
        <Field label="Weight">
          <div className="flex items-center gap-1">
            <select
              value={s.fontWeight ?? 400}
              onChange={(e) =>
                upd({ fontWeight: parseInt(e.target.value, 10) })
              }
              className="h-7 px-2 border border-border rounded bg-background text-xs flex-1"
            >
              {WEIGHTS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() =>
                upd({
                  fontStyle: s.fontStyle === "italic" ? "normal" : "italic",
                })
              }
              className={cn(
                "h-7 w-7 border border-border rounded flex items-center justify-center",
                s.fontStyle === "italic"
                  ? "bg-accent text-accent-foreground border-accent"
                  : "hover:bg-muted"
              )}
              aria-label="Toggle italic"
              title="Italic"
            >
              <Italic className="h-3 w-3" />
            </button>
          </div>
        </Field>

        {/* Color */}
        <Field label="Color">
          <div className="flex items-center gap-1 relative">
            <button
              type="button"
              onClick={() => setShowSwatches((v) => !v)}
              className="h-7 w-7 border border-border rounded shrink-0"
              style={{ background: s.color ?? "#000000" }}
              aria-label="Open color palette"
            />
            <input
              type="text"
              value={s.color ?? ""}
              placeholder="#000000"
              onChange={(e) => upd({ color: e.target.value })}
              className="h-7 px-2 border border-border rounded bg-background text-xs w-full font-mono"
            />
            {showSwatches && (
              <div className="absolute z-20 top-8 left-0 bg-surface border border-border rounded-md shadow-lg p-2 grid grid-cols-4 gap-1 w-44">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      upd({ color: c });
                      setShowSwatches(false);
                    }}
                    className="h-7 w-7 rounded border border-border"
                    style={{ background: c }}
                    aria-label={`Use color ${c}`}
                  />
                ))}
                <input
                  type="color"
                  value={normalizeHex(s.color)}
                  onChange={(e) => upd({ color: e.target.value })}
                  className="col-span-4 h-7 w-full border border-border rounded"
                />
              </div>
            )}
          </div>
        </Field>

        {/* Alignment */}
        <Field label="Align">
          <div className="flex items-center gap-1">
            {(
              [
                ["left", AlignLeft],
                ["center", AlignCenter],
                ["right", AlignRight],
                ["justify", AlignJustify],
              ] as const
            ).map(([val, Icon]) => (
              <button
                key={val}
                type="button"
                onClick={() => upd({ textAlign: val })}
                className={cn(
                  "h-7 w-7 border border-border rounded flex items-center justify-center",
                  align === val
                    ? "bg-accent text-accent-foreground border-accent"
                    : "hover:bg-muted"
                )}
                aria-label={`Align ${val}`}
                title={val}
              >
                <Icon className="h-3 w-3" />
              </button>
            ))}
          </div>
        </Field>

        {/* Line height */}
        <Field label="Line height">
          <input
            type="number"
            step={0.1}
            min={0.5}
            max={3.0}
            value={lineHeight}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v))
                upd({ lineHeight: Math.max(0.5, Math.min(3.0, v)) });
            }}
            className="h-7 px-2 border border-border rounded bg-background text-xs w-full"
          />
        </Field>

        {/* Letter spacing */}
        <Field label="Letter spacing (px)">
          <input
            type="number"
            step={0.5}
            min={-10}
            max={50}
            value={letterSpacing}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v))
                upd({ letterSpacing: Math.max(-10, Math.min(50, v)) });
            }}
            className="h-7 px-2 border border-border rounded bg-background text-xs w-full"
          />
        </Field>

        {/* Read-only transform info */}
        {!multi && (
          <div className="pt-2 mt-2 border-t border-border">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Transform
            </div>
            <div className="font-mono text-[10px] text-muted-foreground space-y-0.5">
              <div>
                x {Math.round(layer.transform.x)}, y {Math.round(layer.transform.y)}
              </div>
              <div>
                w {Math.round(layer.transform.w)} × h {Math.round(layer.transform.h)}
              </div>
              <div>rot {Math.round(layer.transform.rotation)}°</div>
            </div>
          </div>
        )}
      </div>

      {allLayers && onSelectLayer && onDeleteLayer && onZOrderLayer && (
        <LayersPanel
          layers={allLayers}
          selectedIds={selectedIds ?? []}
          labels={layerLabels}
          onSelect={onSelectLayer}
          onDelete={onDeleteLayer}
          onZOrder={onZOrderLayer}
        />
      )}
    </aside>
  );
}

/**
 * Compute the shared subset of a `LayerStyle` across multiple layers: a key
 * is included only if every layer has the same value. Differing keys are
 * left undefined so the corresponding control falls back to its placeholder.
 */
function sharedStyleFor(layers: CanvasLayer[]): LayerStyle {
  if (layers.length === 0) return {};
  const first = layers[0].style;
  const keys: (keyof LayerStyle)[] = [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "color",
    "textAlign",
    "lineHeight",
    "letterSpacing",
    "textTransform",
  ];
  const out: LayerStyle = {};
  for (const k of keys) {
    const v = first[k];
    let allMatch = true;
    for (let i = 1; i < layers.length; i++) {
      if (layers[i].style[k] !== v) {
        allMatch = false;
        break;
      }
    }
    if (allMatch && v != null) {
      // narrow assignment via any to thread through the heterogeneous map
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

function AlignBtn({
  kind,
  label,
  Icon,
  disabled,
  onAlign,
}: {
  kind: AlignKind;
  label: string;
  Icon: typeof AlignLeft;
  disabled?: boolean;
  onAlign: (kind: AlignKind) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onAlign(kind)}
      className={cn(
        "h-7 w-7 border border-border rounded flex items-center justify-center",
        disabled
          ? "opacity-40 cursor-not-allowed"
          : "hover:bg-muted hover:border-accent"
      )}
      title={label}
      aria-label={label}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

function AlignToolbar({
  selectionSize,
  onAlign,
}: {
  selectionSize: number;
  onAlign: (kind: AlignKind) => void;
}) {
  const distributeOk = selectionSize >= 3;
  return (
    <div className="px-3 py-2 border-b border-border">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        Align
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        <AlignBtn kind="left" label="Align left" Icon={AlignStartVertical} onAlign={onAlign} />
        <AlignBtn kind="h-center" label="Align horizontal center" Icon={AlignHorizontalJustifyCenter} onAlign={onAlign} />
        <AlignBtn kind="right" label="Align right" Icon={AlignEndVertical} onAlign={onAlign} />
        <span className="w-px h-5 bg-border mx-0.5" />
        <AlignBtn kind="top" label="Align top" Icon={AlignStartHorizontal} onAlign={onAlign} />
        <AlignBtn kind="v-center" label="Align vertical center" Icon={AlignVerticalJustifyCenter} onAlign={onAlign} />
        <AlignBtn kind="bottom" label="Align bottom" Icon={AlignEndHorizontal} onAlign={onAlign} />
        <span className="w-px h-5 bg-border mx-0.5" />
        <AlignBtn
          kind="distribute-h"
          label="Distribute horizontally"
          Icon={AlignHorizontalDistributeCenter}
          disabled={!distributeOk}
          onAlign={onAlign}
        />
        <AlignBtn
          kind="distribute-v"
          label="Distribute vertically"
          Icon={AlignVerticalDistributeCenter}
          disabled={!distributeOk}
          onAlign={onAlign}
        />
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

function normalizeHex(c: string | undefined): string {
  if (!c) return "#000000";
  const m = c.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (m) return "#" + m[1];
  const m3 = c.trim().match(/^#?([0-9a-fA-F]{3})$/);
  if (m3) {
    const [r, g, b] = m3[1].split("");
    return "#" + r + r + g + g + b + b;
  }
  return "#000000";
}
