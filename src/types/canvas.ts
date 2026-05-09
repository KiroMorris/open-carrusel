/**
 * Canvas postMessage protocol types.
 *
 * Shared between:
 *   - The editor runtime (`src/lib/editor-runtime.ts`) — runs inside the
 *     editor iframe.
 *   - The parent React components (`CanvasIframe`, `useCanvasMessages`,
 *     and downstream callers in Phase 3+).
 *
 * The runtime itself does NOT import this file (it ships untyped after the
 * type-stripping build step). It's the parent's contract for what messages
 * to send and what shapes to expect back.
 *
 * Phase 2 ships the subset listed in plan §11; Phase 3+ will extend the
 * union types here with `apply-style`, `apply-text`, `add-layer`, etc.
 */

import type {
  CanvasLayer,
  CanvasOverrides,
  LayerKind,
  LayerStyle,
  LayerTransform,
} from "./carousel";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Modifiers {
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export interface MeasuredLayer {
  id: string;
  rect: Rect;
  kind: LayerKind;
}

// Parent → iframe ------------------------------------------------------------

export type ParentToIframeMessage =
  | { type: "oc:editor:init"; payload: { overrides: CanvasOverrides | null } }
  | { type: "oc:editor:set-selection"; payload: { ids: string[] } }
  | {
      type: "oc:editor:apply-transform";
      payload: { id: string; transform: Partial<LayerTransform> };
    }
  | {
      type: "oc:editor:apply-style";
      payload: { id: string; style: Partial<LayerStyle> };
    }
  // Phase 3: ask the runtime to re-measure all layer rects + emit `oc:editor:layout`.
  // Sent after a batch of `apply-transform`s so the parent's hit-test cache is
  // refreshed without forcing a full srcDoc re-render.
  | { type: "oc:editor:re-measure"; payload?: undefined }
  // Phase 4: layer add / delete / z-order / inline text.
  | { type: "oc:editor:add-layer"; payload: { layer: CanvasLayer } }
  | { type: "oc:editor:delete-layer"; payload: { id: string } }
  | {
      type: "oc:editor:set-z-order";
      payload: { id: string; direction: "forward" | "back" | "top" | "bottom" };
    }
  | { type: "oc:editor:apply-text"; payload: { id: string; text: string } }
  | { type: "oc:editor:enter-inline-edit"; payload: { id: string } };

export type ParentToIframeType = ParentToIframeMessage["type"];

// Iframe → parent ------------------------------------------------------------

export interface ReadyMessage {
  type: "oc:editor:ready";
  payload: { slideW: number; slideH: number };
}
export interface LayoutMessage {
  type: "oc:editor:layout";
  payload: { layers: MeasuredLayer[] };
}
export interface PointerDownMessage {
  type: "oc:editor:pointer-down";
  payload: {
    id: string | null;
    clientX: number;
    clientY: number;
    modifiers: Modifiers;
  };
}
export interface PointerMoveMessage {
  type: "oc:editor:pointer-move";
  payload: {
    deltaX: number;
    deltaY: number;
    clientX: number;
    clientY: number;
    modifiers: Modifiers;
  };
}
export interface PointerUpMessage {
  type: "oc:editor:pointer-up";
  payload?: undefined;
}
export interface DoubleClickTextMessage {
  type: "oc:editor:dblclick-text";
  payload: { id: string };
}
// Phase 4 — emitted on contenteditable blur after inline-edit.
export interface TextEditMessage {
  type: "oc:editor:text-edit";
  payload: { id: string; text: string };
}

export type IframeToParentMessage =
  | ReadyMessage
  | LayoutMessage
  | PointerDownMessage
  | PointerMoveMessage
  | PointerUpMessage
  | DoubleClickTextMessage
  | TextEditMessage;

export type IframeToParentType = IframeToParentMessage["type"];

// Convenience: extract the payload type for a given message tag.
export type PayloadOf<T extends IframeToParentMessage["type"]> = Extract<
  IframeToParentMessage,
  { type: T }
>["payload"];

// Re-export commonly-used carousel types so consumers can import everything
// they need from one place.
export type { CanvasLayer, CanvasOverrides, LayerKind, LayerStyle, LayerTransform };
