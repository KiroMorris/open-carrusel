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

/**
 * Phase 6 — burst merge window.
 *
 * Pan/zoom in inside-frame mode emits `image-pan` / `image-zoom` per pointer
 * tick (60+ Hz). Without merging, a single zoom gesture would push hundreds
 * of undo entries — the user would have to mash Cmd+Z forever to back out a
 * single pinch.
 *
 * Strategy: if `push()` is called within `BURST_WINDOW_MS` of the previous
 * push, REPLACE the top of the past stack instead of growing it. The first
 * call in a window establishes the snapshot we can roll back to; subsequent
 * pushes within the window are coalesced because the displaced state is the
 * same one we already captured.
 *
 * The CanvasEditor already debounces save+push at 350ms, so this defends
 * additional callers (e.g. direct pan/zoom forwarders that bypass the save
 * debounce in Phase 4+) from blowing up the stack.
 */
const BURST_WINDOW_MS = 500;

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
  // Phase 6 — last push timestamp, used to merge bursts. `0` means "no recent
  // push, next push starts a fresh entry".
  const lastPushAtRef = useRef<number>(0);
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
    const now = Date.now();
    const sinceLast = now - lastPushAtRef.current;
    // Burst-merge: if we pushed within the window, the prior entry already
    // captured the "before" state for this whole gesture. The new pushed
    // snapshot is INTERMEDIATE state we don't want as its own undo step;
    // discard it and keep the older snapshot at the top of past.
    if (
      lastPushAtRef.current !== 0 &&
      sinceLast < BURST_WINDOW_MS &&
      pastRef.current.length > 0
    ) {
      // No-op on the stack itself: keep the original "before" snapshot.
      // Just refresh the timestamp so the window slides while bursts continue.
      lastPushAtRef.current = now;
      // A new branch still invalidates redo (a mutation happened).
      if (futureRef.current.length) {
        futureRef.current = [];
        bump();
      }
      return;
    }
    pastRef.current.push(clone(snapshot));
    if (pastRef.current.length > MAX_DEPTH) pastRef.current.shift();
    lastPushAtRef.current = now;
    // A new branch invalidates redo history.
    if (futureRef.current.length) futureRef.current = [];
    bump();
  }, []);

  const undo = useCallback(() => {
    if (!pastRef.current.length) return undefined;
    const prev = pastRef.current.pop()!;
    futureRef.current.push(clone(currentRef.current));
    if (futureRef.current.length > MAX_DEPTH) futureRef.current.shift();
    // Break the burst window so the next user mutation starts a fresh entry.
    lastPushAtRef.current = 0;
    bump();
    return prev;
  }, []);

  const redo = useCallback(() => {
    if (!futureRef.current.length) return undefined;
    const next = futureRef.current.pop()!;
    pastRef.current.push(clone(currentRef.current));
    if (pastRef.current.length > MAX_DEPTH) pastRef.current.shift();
    lastPushAtRef.current = 0;
    bump();
    return next;
  }, []);

  const reset = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    lastPushAtRef.current = 0;
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
