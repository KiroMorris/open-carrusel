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
  FrameTransform,
  ImageInnerTransform,
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

/**
 * Phase 2 note on `kind`:
 *
 * The runtime reports a unified `layerOrder` over text + image-frame +
 * shape entries. To keep existing text-only consumers compiling without
 * a Phase 3 cascade, `MeasuredLayer.kind` is intentionally still narrowed
 * to `LayerKind` ("existing" | "new"). Image-frame and shape entries are
 * stamped as `"existing"` in the layout payload; consumers that need to
 * disambiguate must look up the id in `CanvasOverrides.images` or
 * `CanvasOverrides.shapes` (or listen to the `image-frame-init` /
 * `shape-init` messages, which fire once per detected non-text entry).
 *
 * Phase 3 will widen this union and update callers in lockstep.
 */
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
  | { type: "oc:editor:enter-inline-edit"; payload: { id: string } }
  // Phase 2 (canvas-image-frames) — image + shape live updates.
  // These mirror the text path's `apply-transform`/`apply-style` shape but
  // dispatch into the image/shape entry maps inside the runtime.
  | {
      type: "oc:editor:apply-image-transform";
      payload: {
        id: string;
        frame?: Partial<FrameTransform>;
        image?: Partial<ImageInnerTransform>;
      };
    }
  | {
      type: "oc:editor:apply-shape-transform";
      payload: { id: string; frame?: Partial<FrameTransform> };
    }
  // Phase 4 wires actual cursor/intercept behavior; Phase 2 just acks the
  // message and mutates a `currentMode` state inside the runtime.
  | {
      type: "oc:editor:set-frame-mode";
      payload: { id: string; mode: "frame" | "inside-frame" };
    };

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
// `computed` carries the original element's resolved style snapshot so the
// parent can seed the override's style fields. Without it, the replica <div>
// applyOverrides emits inherits browser defaults instead of looking like the
// original glyphs.
export interface TextEditMessage {
  type: "oc:editor:text-edit";
  payload: {
    id: string;
    text: string;
    computed?: {
      fontFamily?: string;
      fontSize?: number;
      fontWeight?: number;
      fontStyle?: "normal" | "italic";
      color?: string;
      textAlign?: string;
      lineHeight?: number;
      letterSpacing?: number;
    };
  };
}

// Phase 2 — emitted once per detected image frame at boot. The parent uses
// the payload to seed an `ImageOverride` on first edit (so we never have to
// guess `naturalFrameRect` after the user has already nudged the frame).
export interface ImageFrameInitMessage {
  type: "oc:editor:image-frame-init";
  payload: {
    id: string;
    natural: { w: number; h: number };
    source: "wrapped" | "parent" | "background";
    frame: FrameTransform;
    image: ImageInnerTransform;
    naturalFrameRect: { x: number; y: number; w: number; h: number };
  };
}

// Phase 2 — emitted once per detected shape at boot. Parents seed a
// `ShapeOverride` with the captured `naturalRect` so subsequent transforms
// produce correct translate deltas.
export interface ShapeInitMessage {
  type: "oc:editor:shape-init";
  payload: {
    id: string;
    frame: FrameTransform;
    naturalRect: { x: number; y: number; w: number; h: number };
  };
}

// Phase 4 territory — defined now so the protocol surface is stable; the
// runtime does NOT emit these in Phase 2.
export interface ImagePanMessage {
  type: "oc:editor:image-pan";
  payload: { id: string; image: ImageInnerTransform };
}

export interface ImageZoomMessage {
  type: "oc:editor:image-zoom";
  payload: { id: string; image: ImageInnerTransform };
}

export type IframeToParentMessage =
  | ReadyMessage
  | LayoutMessage
  | PointerDownMessage
  | PointerMoveMessage
  | PointerUpMessage
  | DoubleClickTextMessage
  | TextEditMessage
  | ImageFrameInitMessage
  | ShapeInitMessage
  | ImagePanMessage
  | ImageZoomMessage;

export type IframeToParentType = IframeToParentMessage["type"];

// Convenience: extract the payload type for a given message tag.
export type PayloadOf<T extends IframeToParentMessage["type"]> = Extract<
  IframeToParentMessage,
  { type: T }
>["payload"];

// Re-export commonly-used carousel types so consumers can import everything
// they need from one place.
export type {
  CanvasLayer,
  CanvasOverrides,
  FrameTransform,
  ImageInnerTransform,
  LayerKind,
  LayerStyle,
  LayerTransform,
};
