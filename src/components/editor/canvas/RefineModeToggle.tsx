"use client";

/**
 * RefineModeToggle — toolbar button that flips between read-only preview and
 * the canvas refine editor. Shows a small lock badge when the active slide
 * already has non-empty `canvasOverrides` (Phase 5 will use this badge to
 * cue the user that the slide is locked from chat).
 */

import { Lock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CanvasOverrides } from "@/types/carousel";

interface RefineModeToggleProps {
  mode: "preview" | "refine";
  onToggle: (next: "preview" | "refine") => void;
  overrides?: CanvasOverrides | null;
  className?: string;
}

export function RefineModeToggle({
  mode,
  onToggle,
  overrides,
  className,
}: RefineModeToggleProps) {
  const isLocked = !!overrides && Object.keys(overrides.layers).length > 0;
  const isOn = mode === "refine";
  return (
    <Button
      variant={isOn ? "outline" : "ghost"}
      size="sm"
      onClick={() => onToggle(isOn ? "preview" : "refine")}
      className={cn(
        "h-8 gap-1.5 px-3 text-xs relative",
        isOn ? "border-accent text-accent" : "text-muted-foreground",
        className
      )}
      aria-label={isOn ? "Exit refine mode" : "Enter refine mode"}
      title={
        isOn
          ? "Exit refine mode (Esc)"
          : "Refine: drag, resize, and restyle text on this slide"
      }
    >
      <Pencil className="h-3.5 w-3.5" />
      Refine
      {isLocked && (
        <span
          className="ml-1 inline-flex items-center justify-center rounded-sm bg-[var(--brand-yellow)] text-[var(--brand-green)] h-4 w-4"
          title="This slide has canvas refinements"
        >
          <Lock className="h-2.5 w-2.5" />
        </span>
      )}
    </Button>
  );
}
