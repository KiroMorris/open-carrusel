"use client";

/**
 * useCanvasUndo — per-slide ephemeral undo/redo stack of `CanvasOverrides`
 * snapshots.
 *
 * Phase 3 contract:
 *   - Caller decides WHEN to push (typically: 350 ms debounce after any
 *     committable change in `CanvasEditor`).
 *   - Stack is in-memory only. Slide change clears it. Refine-mode exit
 *     clears it.
 *   - Cap at 50 entries (`past.shift()` when exceeded).
 *   - `undo()` / `redo()` return the snapshot the caller should now apply
 *     (or `null` if nothing to do). The caller is responsible for shipping
 *     the snapshot to the iframe + persisting it to the API.
 *
 * Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z bindings live in `CanvasEditor` (so they
 * scope to the editor and don't fight the chat panel).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasOverrides } from "@/types/carousel";

const MAX_DEPTH = 50;

function clone(o: CanvasOverrides | null): CanvasOverrides | null {
  if (!o) return null;
  // Structured clone via JSON is fine here — overrides are plain JSON shapes.
  return JSON.parse(JSON.stringify(o)) as CanvasOverrides;
}

export interface CanvasUndoApi {
  /** Push the CURRENT (pre-change) snapshot before the caller mutates state. */
  push: (snapshot: CanvasOverrides | null) => void;
  /** Pop one snapshot off `past`; returns it (caller applies). */
  undo: () => CanvasOverrides | null | undefined;
  /** Pop one snapshot off `future`; returns it (caller applies). */
  redo: () => CanvasOverrides | null | undefined;
  canUndo: boolean;
  canRedo: boolean;
  /** Reset both stacks (slide change / mode exit). */
  reset: () => void;
  /**
   * Snapshot the CURRENT state into `past` BEFORE applying an undo/redo.
   * Used so the inverse op can roll forward again. Most callers won't need
   * this — `undo()` and `redo()` handle it internally.
   */
  rememberCurrent: (current: CanvasOverrides | null) => void;
}

/**
 * @param current  The component's *current* overrides — used by undo/redo
 *                 to push the displaced state onto the opposite stack so
 *                 the user can roll back the undo.
 */
export function useCanvasUndo(
  current: CanvasOverrides | null
): CanvasUndoApi {
  const pastRef = useRef<Array<CanvasOverrides | null>>([]);
  const futureRef = useRef<Array<CanvasOverrides | null>>([]);
  // Keep `current` in a ref so undo/redo see the latest value without
  // making the callbacks unstable.
  const currentRef = useRef<CanvasOverrides | null>(current);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  // Tick state so consumers can re-render `canUndo` / `canRedo`.
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => (t + 1) & 0xffff);

  const push = useCallback((snapshot: CanvasOverrides | null) => {
    pastRef.current.push(clone(snapshot));
    if (pastRef.current.length > MAX_DEPTH) pastRef.current.shift();
    // A new branch invalidates redo history.
    if (futureRef.current.length) futureRef.current = [];
    bump();
  }, []);

  const undo = useCallback(() => {
    if (!pastRef.current.length) return undefined;
    const prev = pastRef.current.pop()!;
    futureRef.current.push(clone(currentRef.current));
    if (futureRef.current.length > MAX_DEPTH) futureRef.current.shift();
    bump();
    return prev;
  }, []);

  const redo = useCallback(() => {
    if (!futureRef.current.length) return undefined;
    const next = futureRef.current.pop()!;
    pastRef.current.push(clone(currentRef.current));
    if (pastRef.current.length > MAX_DEPTH) pastRef.current.shift();
    bump();
    return next;
  }, []);

  const reset = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    bump();
  }, []);

  const rememberCurrent = useCallback((c: CanvasOverrides | null) => {
    currentRef.current = c;
  }, []);

  return {
    push,
    undo,
    redo,
    reset,
    rememberCurrent,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  };
}
