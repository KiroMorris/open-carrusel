"use client";

/**
 * Phase 6 — Keyboard help overlay.
 *
 * A modal cheat-sheet listing every canvas-editor keyboard shortcut. Toggled
 * with the `?` key (Shift+/) when no input/textarea/contenteditable element
 * is focused — i.e. when the user is interacting with the canvas itself.
 *
 * Self-contained: uses the same Radix Dialog primitive idiom as the rest of
 * the app's modal surfaces, plus the Open Carrusel brand tokens. CanvasEditor
 * just renders <KeyboardHelpOverlay /> once; no props required.
 */

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Keyboard, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Shortcut data
// ---------------------------------------------------------------------------

interface Shortcut {
  /** Pre-rendered key chips, e.g. ["Cmd", "Z"]. */
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Move & Nudge",
    items: [
      { keys: ["←", "→", "↑", "↓"], label: "Nudge selected layer 1px" },
      { keys: ["Shift", "Arrow"], label: "Nudge 10px" },
      { keys: ["Shift", "drag"], label: "Disable snap while dragging" },
      { keys: ["Alt", "drag"], label: "Free move (no snap)" },
    ],
  },
  {
    title: "Edit",
    items: [
      { keys: ["Dbl-click"], label: "Edit text inline" },
      { keys: ["T"], label: "Insert a new text layer" },
      { keys: ["Delete"], label: "Remove the selected layer" },
      { keys: ["Cmd", "D"], label: "Duplicate the selected layer" },
    ],
  },
  {
    title: "Layer order",
    items: [
      { keys: ["Cmd", "]"], label: "Bring forward" },
      { keys: ["Cmd", "["], label: "Send back" },
    ],
  },
  {
    title: "History",
    items: [
      { keys: ["Cmd", "Z"], label: "Undo" },
      { keys: ["Cmd", "Shift", "Z"], label: "Redo" },
    ],
  },
  {
    title: "Selection",
    items: [
      { keys: ["Esc"], label: "Clear selection / exit refine mode" },
      { keys: ["?"], label: "Show this shortcut sheet" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Focus guard: don't trigger `?` while the user is typing somewhere.
// ---------------------------------------------------------------------------

function isTextInputFocused(): boolean {
  const el = typeof document === "undefined" ? null : document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KeyboardHelpOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // `?` is Shift+/. Some non-US keyboards report `?` directly; both work.
      if (e.key !== "?" && !(e.key === "/" && e.shiftKey)) return;
      if (isTextInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-oc-overlay
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        />
        <Dialog.Content
          data-oc-dialog
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2",
            "rounded-xl bg-surface border border-border p-6 shadow-2xl",
            "max-h-[85vh] overflow-y-auto"
          )}
        >
          <div className="flex items-start gap-3 mb-5">
            <div className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 bg-accent/10 text-accent">
              <Keyboard className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <Dialog.Title className="text-sm font-semibold">
                Canvas keyboard shortcuts
              </Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground mt-1">
                Press{" "}
                <kbd className="px-1.5 py-0.5 rounded border border-border bg-muted text-[10px] font-mono">
                  ?
                </kbd>{" "}
                anytime in refine mode to toggle this sheet.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                className="h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
            {GROUPS.map((group) => (
              <section key={group.title}>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  {group.title}
                </h3>
                <ul className="space-y-1.5">
                  {group.items.map((s, i) => (
                    <li
                      key={`${group.title}-${i}`}
                      className="flex items-center justify-between gap-3 text-xs"
                    >
                      <span className="text-foreground/90">{s.label}</span>
                      <span className="flex items-center gap-1 shrink-0">
                        {s.keys.map((k, ki) => (
                          <kbd
                            key={ki}
                            className={cn(
                              "px-1.5 py-0.5 rounded border border-border",
                              "bg-muted text-[10px] font-mono text-foreground/90",
                              "min-w-[20px] text-center"
                            )}
                          >
                            {k}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <div className="mt-6 pt-4 border-t border-border text-[11px] text-muted-foreground">
            On Windows/Linux, swap <span className="font-mono">Cmd</span> for{" "}
            <span className="font-mono">Ctrl</span>.
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
