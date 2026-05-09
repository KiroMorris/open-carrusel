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
  Layers,
  Trash2,
  Type,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasLayer } from "@/types/carousel";

export type ZDirection = "forward" | "back" | "top" | "bottom";

interface LayersPanelProps {
  /** All layers, in render order (bottom → top). */
  layers: CanvasLayer[];
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
            const label = (labels && labels[layer.id]) || layer.text || layer.id;
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
                    layer.kind === "new"
                      ? "bg-[var(--brand-yellow)] text-[var(--brand-green)]"
                      : "bg-muted text-muted-foreground"
                  )}
                  title={layer.kind === "new" ? "New layer" : "Existing layer"}
                >
                  {layer.kind === "new" ? (
                    <Type className="h-2.5 w-2.5" />
                  ) : (
                    <Eye className="h-2.5 w-2.5" />
                  )}
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

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
