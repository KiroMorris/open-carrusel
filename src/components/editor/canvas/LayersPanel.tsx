"use client";

/**
 * LayersPanel — collapsible list of every layer with z-order + delete.
 *
 * Phase 4. Embedded inside Inspector by default (collapsed). Useful when
 * layers stack visually and clicking the canvas can't disambiguate.
 *
 * Pure-presentational: parent owns selection + override state and supplies
 * callbacks. The panel never mutates anything directly.
 */

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  Eye,
  Image as ImageIcon,
  Layers,
  Square,
  Trash2,
  Type,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasLayer } from "@/types/carousel";

export type ZDirection = "forward" | "back" | "top" | "bottom";

/**
 * Phase 3 (canvas-image-frames). Each entry tagged with kind so we can
 * render the right icon + label fallback. Shapes and image-frames are NOT
 * `CanvasLayer`s (they live in `overrides.images` / `overrides.shapes`),
 * so we accept a structural shape rather than a typed `CanvasLayer`.
 */
export type LayerListKind = "text-existing" | "text-new" | "image-frame" | "shape";

export interface LayerListEntry {
  id: string;
  kind: LayerListKind;
  /** Optional preview text — falls back to id-based label. */
  text?: string;
}

interface LayersPanelProps {
  /** All entries, in render order (bottom → top). May include text layers
   *  AND image-frame / shape entries. */
  layers: LayerListEntry[];
  /** Currently selected layer ids. */
  selectedIds: string[];
  /** Layer ids whose label should reflect the source text (existing layers
   *  often don't have an override `text`; supply current text from the
   *  iframe's last `oc:editor:layout` or fall back to the id). */
  labels?: Record<string, string>;
  onSelect: (id: string, additive: boolean) => void;
  onDelete: (id: string) => void;
  onZOrder: (id: string, direction: ZDirection) => void;
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Convenience: build a `LayerListEntry` from a text `CanvasLayer`. Kept as a
 * helper so existing call sites that already had `CanvasLayer[]` migrate
 * cleanly.
 */
export function textLayerToEntry(layer: CanvasLayer): LayerListEntry {
  return {
    id: layer.id,
    kind: layer.kind === "new" ? "text-new" : "text-existing",
    text: layer.text,
  };
}

export function LayersPanel({
  layers,
  selectedIds,
  labels,
  onSelect,
  onDelete,
  onZOrder,
  defaultOpen = false,
  className,
}: LayersPanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  // Render top → bottom in the UI (matches "z-stack" mental model: top of
  // the list is what's drawn on top of the canvas).
  const display = [...layers].reverse();

  return (
    <div
      className={cn(
        "border-t border-border",
        className
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/50"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Layers className="h-3 w-3" />
          Layers ({layers.length})
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
      </button>

      {open && (
        <ul className="max-h-72 overflow-y-auto py-1 text-xs">
          {display.length === 0 && (
            <li className="px-3 py-2 text-muted-foreground italic">
              No layers yet.
            </li>
          )}
          {display.map((layer) => {
            const sel = selectedIds.includes(layer.id);
            const fallback =
              layer.kind === "image-frame"
                ? `image · ${layer.id}`
                : layer.kind === "shape"
                  ? `shape · ${layer.id}`
                  : layer.id;
            const label =
              (labels && labels[layer.id]) || layer.text || fallback;
            const { Icon, swatch, hint } = iconFor(layer.kind);
            return (
              <li
                key={layer.id}
                className={cn(
                  "group flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-muted/50",
                  sel && "bg-accent/15"
                )}
                onClick={(e) => onSelect(layer.id, e.shiftKey || e.metaKey || e.ctrlKey)}
              >
                <span
                  className={cn(
                    "h-4 w-4 rounded shrink-0 flex items-center justify-center",
                    swatch
                  )}
                  title={hint}
                >
                  <Icon className="h-2.5 w-2.5" />
                </span>
                <span
                  className="flex-1 truncate text-foreground"
                  title={label}
                >
                  {truncate(label, 24)}
                </span>
                <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                  <IconBtn
                    onClick={(e) => {
                      e.stopPropagation();
                      onZOrder(layer.id, "top");
                    }}
                    title="Bring to front"
                  >
                    <ChevronsUp className="h-3 w-3" />
                  </IconBtn>
                  <IconBtn
                    onClick={(e) => {
                      e.stopPropagation();
                      onZOrder(layer.id, "forward");
                    }}
                    title="Bring forward (Cmd+])"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </IconBtn>
                  <IconBtn
                    onClick={(e) => {
                      e.stopPropagation();
                      onZOrder(layer.id, "back");
                    }}
                    title="Send backward (Cmd+[)"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </IconBtn>
                  <IconBtn
                    onClick={(e) => {
                      e.stopPropagation();
                      onZOrder(layer.id, "bottom");
                    }}
                    title="Send to back"
                  >
                    <ChevronsDown className="h-3 w-3" />
                  </IconBtn>
                  <IconBtn
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(layer.id);
                    }}
                    title="Delete (Backspace)"
                    danger
                  >
                    <Trash2 className="h-3 w-3" />
                  </IconBtn>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "h-5 w-5 rounded flex items-center justify-center hover:bg-muted",
        danger && "hover:bg-destructive/15 hover:text-destructive"
      )}
    >
      {children}
    </button>
  );
}

function iconFor(kind: LayerListKind): {
  Icon: typeof Type;
  swatch: string;
  hint: string;
} {
  switch (kind) {
    case "text-new":
      return {
        Icon: Type,
        swatch: "bg-[var(--brand-yellow)] text-[var(--brand-green)]",
        hint: "New text layer",
      };
    case "text-existing":
      return {
        Icon: Eye,
        swatch: "bg-muted text-muted-foreground",
        hint: "Existing text layer",
      };
    case "image-frame":
      return {
        Icon: ImageIcon,
        swatch: "bg-muted text-muted-foreground",
        hint: "Image frame",
      };
    case "shape":
      return {
        Icon: Square,
        swatch: "bg-muted text-muted-foreground",
        hint: "Shape",
      };
  }
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
