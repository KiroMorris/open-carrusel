"use client";

/**
 * CanvasEditor — Phase 3 top-level refine-mode editor for ONE slide.
 *
 * Owns:
 *   - Local `overrides` state (mirrors `slide.canvasOverrides`).
 *   - Selection (single layer for Phase 3).
 *   - Layout cache (last `oc:editor:layout` payload, used as a starting point
 *     for "what's the bbox of an as-yet-unedited existing layer?").
 *   - Undo stack (in-memory, ephemeral, per-slide).
 *   - Pointer state for drag/resize/rotate happening either inside the iframe
 *     (drag) or on the SVG overlay (resize/rotate handles).
 *   - Debounced PUT to /api/.../slides/{slideId} with `X-OC-Source: canvas`.
 *
 * Coordinate spaces (Phase 2 landmine #1):
 *   - Layer transforms are in SLIDE coords. The iframe's intrinsic viewport
 *     equals slide coords (1080×1350), so `getBoundingClientRect()` inside
 *     the iframe also returns slide coords — which is what the runtime sends.
 *   - The iframe is `transform: scale(s)` in the parent. SelectionOverlay
 *     handles the slide-→parent multiply. Drag deltas from the runtime are
 *     ALREADY slide coords. Drag deltas from the SVG overlay are PARENT
 *     coords; SelectionOverlay does the inverse-scale before handing them
 *     up here.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { CanvasIframe } from "./CanvasIframe";
import {
  Inspector,
  type AlignKind,
  type InspectorSelectedItem,
} from "./Inspector";
import { KeyboardHelpOverlay } from "./KeyboardHelpOverlay";
import {
  SelectionOverlay,
  type HandleId,
  type MarqueeRect,
  type OverlayDragStart,
  type SelectionKind,
} from "./SelectionOverlay";
import { useCanvasUndo } from "./useCanvasUndo";
import { rafThrottle } from "@/lib/throttle";
import { computeSnap, type SnapGuide } from "./useSnap";
import {
  textLayerToEntry,
  type LayerListEntry,
  type ZDirection,
} from "./LayersPanel";
import type {
  CanvasLayer,
  CanvasOverrides,
  FrameTransform,
  ImageOverride,
  LayerStyle,
  LayerTransform,
  ShapeOverride,
} from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import type {
  ImageFrameInitMessage,
  MeasuredLayer,
  Modifiers,
  ParentToIframeMessage,
  ShapeInitMessage,
} from "@/types/canvas";
import { generateId } from "@/lib/utils";

const DEBOUNCE_MS = 350;

interface CanvasEditorProps {
  carouselId: string;
  slideId: string;
  html: string;
  aspectRatio: import("@/types/carousel").AspectRatio;
  initialOverrides: CanvasOverrides | null;
  /** Notify parent when overrides change so it can refresh local carousel state. */
  onOverridesChange?: (overrides: CanvasOverrides | null) => void;
}

function emptyOverrides(): CanvasOverrides {
  return { layers: {}, order: [], schemaVersion: 1 };
}

function defaultStyle(): LayerStyle {
  return {};
}

// BUG-005 — drag must move at least this many pixels (Manhattan distance)
// before we treat the gesture as a real drag and start writing overrides.
const DRAG_THRESHOLD_PX = 3;

// BUG-001 — no-op guard for `mutateLayer({commit:false})`. If the mutator
// produced a layer that's identical to the previous one in every field we
// care about, skip the React state write entirely so the iframe doesn't
// reboot for nothing.
// Phase 3 (canvas-image-frames). Lazy-seeded image-frame and shape entries
// don't enter `overrides.images` / `overrides.shapes` until the user FIRST
// edits them. Until then, the runtime has emitted an init payload that we
// stash in these accumulator maps.
type ImageInitPayload = ImageFrameInitMessage["payload"];
type ShapeInitPayload = ShapeInitMessage["payload"];

function shallowImageEqual(a: ImageOverride, b: ImageOverride): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.kind !== b.kind || a.source !== b.source) return false;
  const af = a.frame;
  const bf = b.frame;
  if (
    af.x !== bf.x ||
    af.y !== bf.y ||
    af.w !== bf.w ||
    af.h !== bf.h ||
    af.rotation !== bf.rotation ||
    af.z !== bf.z
  )
    return false;
  const ai = a.image;
  const bi = b.image;
  if (ai.scale !== bi.scale || ai.tx !== bi.tx || ai.ty !== bi.ty) return false;
  return true;
}

function shallowShapeEqual(a: ShapeOverride, b: ShapeOverride): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.kind !== b.kind || a.source !== b.source) return false;
  const af = a.frame;
  const bf = b.frame;
  if (
    af.x !== bf.x ||
    af.y !== bf.y ||
    af.w !== bf.w ||
    af.h !== bf.h ||
    af.rotation !== bf.rotation ||
    af.z !== bf.z
  )
    return false;
  return true;
}

function shallowLayerEqual(a: CanvasLayer, b: CanvasLayer): boolean {
  if (a === b) return true;
  if (a.text !== b.text) return false;
  if (a.kind !== b.kind) return false;
  const at = a.transform;
  const bt = b.transform;
  if (
    at.x !== bt.x ||
    at.y !== bt.y ||
    at.w !== bt.w ||
    at.h !== bt.h ||
    at.rotation !== bt.rotation ||
    at.z !== bt.z
  ) {
    return false;
  }
  const as = a.style ?? {};
  const bs = b.style ?? {};
  const styleKeys: (keyof LayerStyle)[] = [
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
  for (const k of styleKeys) {
    if (as[k] !== bs[k]) return false;
  }
  return true;
}

export function CanvasEditor({
  carouselId,
  slideId,
  html,
  aspectRatio,
  initialOverrides,
  onOverridesChange,
}: CanvasEditorProps) {
  const { width: slideW, height: slideH } = DIMENSIONS[aspectRatio];

  // --- Core state ---------------------------------------------------------
  const [overrides, setOverrides] = useState<CanvasOverrides | null>(
    initialOverrides
  );
  // Phase 3 (canvas-image-frames). Init payloads accumulated from the runtime
  // — never cleared during a session. `getOrSeedImage` / `getOrSeedShape` use
  // these to materialize an `ImageOverride` / `ShapeOverride` on first edit.
  const [imageInits, setImageInits] = useState<Map<string, ImageInitPayload>>(
    () => new Map()
  );
  const [shapeInits, setShapeInits] = useState<Map<string, ShapeInitPayload>>(
    () => new Map()
  );
  // Map id → original `<img>` src URL, captured from runtime hints (Phase 3
  // shows it as a thumbnail in the inspector). We extract from the iframe's
  // active document; until that's available we just don't show a thumbnail.
  const [imageSrcById, setImageSrcById] = useState<Map<string, string>>(
    () => new Map()
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Phase 4: multi-select. `selectedId` (Phase 3) is kept as the PRIMARY
  // selection (the layer that owns the resize/rotate handles); `selectedIds`
  // is the full set including primary.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Phase 4 (canvas-image-frames). Inside-frame mode state. `currentMode`
  // mirrors the runtime's mode for the CURRENTLY active image frame; null
  // means no special mode (text/shape selection or empty selection).
  // `activeFrameId` is the id of the image frame whose interior is being
  // panned/zoomed. While in inside-frame mode the SelectionOverlay draws
  // a solid blue outline (no handles), the runtime intercepts pointer +
  // wheel events on that frame, and Esc / outside-click exits.
  const [currentMode, setCurrentMode] = useState<"frame" | "inside-frame" | null>(
    null
  );
  const [activeFrameId, setActiveFrameId] = useState<string | null>(null);
  const [layout, setLayout] = useState<MeasuredLayer[]>([]);
  // Phase 4 — snap guides drawn during a drag.
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  // Phase 4 — marquee rectangle drawn while user drags on empty space.
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  // Phase 4 — "place new text" mode: next iframe click drops a layer there.
  const [placeMode, setPlaceMode] = useState(false);
  // Iframe scale (parent_px per slide_px).
  const [scale, setScale] = useState(0);
  // Outer container rect for positioning the SVG overlay flush over the iframe.
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{
    w: number;
    h: number;
  } | null>(null);

  // --- Refs for iframe send + undo ---------------------------------------
  const sendRef = useRef<((msg: ParentToIframeMessage) => void) | null>(null);

  // Phase 6 perf: collapse drag-time apply-transform sends to one per frame.
  // Drag handlers call `sendTransformThrottled(id, transform)`; the iframe
  // bridge gets at most ~60 messages/sec instead of one per pointermove. We
  // flush on pointer-up so the final position is never dropped.
  const sendTransformThrottled = useMemo(
    () =>
      rafThrottle((id: string, transform: LayerTransform) => {
        sendRef.current?.({
          type: "oc:editor:apply-transform",
          payload: { id, transform },
        });
      }),
    []
  );
  useEffect(() => () => sendTransformThrottled.cancel(), [sendTransformThrottled]);

  const undo = useCanvasUndo(overrides);
  const overridesRef = useRef(overrides);
  useEffect(() => {
    overridesRef.current = overrides;
    undo.rememberCurrent(overrides);
  }, [overrides, undo]);

  // --- Save debounce ------------------------------------------------------
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>(JSON.stringify(initialOverrides));

  const flushSave = useCallback(
    async (snapshot: CanvasOverrides | null) => {
      const json = JSON.stringify(snapshot);
      if (json === lastSavedRef.current) return;
      lastSavedRef.current = json;
      try {
        await fetch(`/api/carousels/${carouselId}/slides/${slideId}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-OC-Source": "canvas",
          },
          body: JSON.stringify({ canvasOverrides: snapshot }),
        });
      } catch {
        // Silent fail; the in-memory state stays correct.
      }
    },
    [carouselId, slideId]
  );

  const scheduleSave = useCallback(
    (next: CanvasOverrides | null, prevForUndo: CanvasOverrides | null) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        // Push the PRE-change snapshot onto the undo stack.
        undo.push(prevForUndo);
        flushSave(next);
        onOverridesChange?.(next);
      }, DEBOUNCE_MS);
    },
    [flushSave, onOverridesChange, undo]
  );

  // Flush pending on slide change / unmount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // Final flush of whatever's current.
      if (
        JSON.stringify(overridesRef.current) !== lastSavedRef.current
      ) {
        flushSave(overridesRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideId]);

  // Phase 3 (canvas-image-frames). Refine-mode exit cleanup. The runtime
  // exposes `__ocRuntimeRestore()` on its `window` to unwrap synthesized
  // image-frame wrappers + restore stashed parent styles. Call it when this
  // editor unmounts (refine → preview, or slide swap), so the iframe DOM
  // is byte-restored to Claude's original layout if the user hasn't saved
  // any persisted overrides for those frames.
  useEffect(() => {
    return () => {
      const iframe = containerRef.current?.querySelector(
        "iframe"
      ) as HTMLIFrameElement | null;
      const win = iframe?.contentWindow as
        | (Window & { __ocRuntimeRestore?: () => void })
        | null;
      try {
        win?.__ocRuntimeRestore?.();
      } catch {
        // The iframe may already be torn down; nothing to do.
      }
    };
  }, []);

  // --- Layer access helpers -----------------------------------------------
  const layoutById = useMemo(() => {
    const m = new Map<string, MeasuredLayer>();
    for (const l of layout) m.set(l.id, l);
    return m;
  }, [layout]);

  const getOrSeedLayer = useCallback(
    (id: string): CanvasLayer | null => {
      const existing = overrides?.layers[id];
      if (existing) return existing;
      const measured = layoutById.get(id);
      if (!measured) return null;
      return {
        id,
        kind: measured.kind,
        transform: {
          x: measured.rect.x,
          y: measured.rect.y,
          w: measured.rect.w,
          h: measured.rect.h,
          rotation: 0,
          z: 0,
        },
        style: defaultStyle(),
      };
    },
    [overrides, layoutById]
  );

  const selectedLayer: CanvasLayer | null = useMemo(() => {
    if (!selectedId) return null;
    return getOrSeedLayer(selectedId);
  }, [selectedId, getOrSeedLayer]);

  // --- Phase 3 (canvas-image-frames): image / shape seeders + kind ------

  const getOrSeedImage = useCallback(
    (id: string): ImageOverride | null => {
      const existing = overrides?.images?.[id];
      if (existing) return existing;
      const init = imageInits.get(id);
      if (!init) return null;
      return {
        id,
        kind: "image-frame",
        frame: { ...init.frame },
        image: { ...init.image },
        natural: { ...init.natural },
        naturalFrameRect: { ...init.naturalFrameRect },
        source: init.source,
      };
    },
    [overrides, imageInits]
  );

  const getOrSeedShape = useCallback(
    (id: string): ShapeOverride | null => {
      const existing = overrides?.shapes?.[id];
      if (existing) return existing;
      const init = shapeInits.get(id);
      if (!init) return null;
      return {
        id,
        kind: "shape",
        frame: { ...init.frame },
        naturalRect: { ...init.naturalRect },
        // Phase 1 ShapeOverride.source: "wrapped" | "parent". Default to
        // "wrapped" — the runtime currently only emits shape-init for entries
        // it has set up via the wrap path.
        source: "wrapped",
      };
    },
    [overrides, shapeInits]
  );

  /**
   * Lookup order (Phase 3 invariant — landmine #4): images → shapes → layers
   * → init maps → null. Each layer id lives in exactly one map.
   */
  type LayerKind = "text" | "image-frame" | "shape";
  const getLayerKind = useCallback(
    (id: string): LayerKind | null => {
      if (overrides?.images?.[id]) return "image-frame";
      if (overrides?.shapes?.[id]) return "shape";
      if (overrides?.layers?.[id]) return "text";
      if (imageInits.has(id)) return "image-frame";
      if (shapeInits.has(id)) return "shape";
      // Fall back to layout (text leaves the runtime detected at boot).
      const measured = layoutById.get(id);
      if (measured) return "text";
      return null;
    },
    [overrides, imageInits, shapeInits, layoutById]
  );

  // Discriminated selection — drives Inspector + SelectionOverlay routing.
  const selectedItem: InspectorSelectedItem = useMemo(() => {
    if (!selectedId) return null;
    const k = getLayerKind(selectedId);
    if (k === "image-frame") {
      const image = getOrSeedImage(selectedId);
      if (!image) return null;
      return {
        kind: "image-frame",
        image,
        sourceSrc: imageSrcById.get(selectedId) ?? null,
      };
    }
    if (k === "shape") {
      const shape = getOrSeedShape(selectedId);
      if (!shape) return null;
      return { kind: "shape", shape };
    }
    if (k === "text") {
      const layer = getOrSeedLayer(selectedId);
      if (!layer) return null;
      return { kind: "text", layer };
    }
    return null;
  }, [
    selectedId,
    getLayerKind,
    getOrSeedImage,
    getOrSeedShape,
    getOrSeedLayer,
    imageSrcById,
  ]);

  // The SelectionOverlay's `transform` prop accepts any LayerTransform-shaped
  // object. For image/shape entries we feed the FrameTransform directly — it
  // structurally matches.
  const selectedKind: SelectionKind =
    selectedItem?.kind === "image-frame"
      ? "image-frame"
      : selectedItem?.kind === "shape"
        ? "shape"
        : "text";

  const selectedFrameTransform: LayerTransform | null = useMemo(() => {
    if (!selectedItem) return selectedLayer?.transform ?? null;
    if (selectedItem.kind === "image-frame") {
      const f = selectedItem.image.frame;
      return { x: f.x, y: f.y, w: f.w, h: f.h, rotation: f.rotation, z: f.z };
    }
    if (selectedItem.kind === "shape") {
      const f = selectedItem.shape.frame;
      return { x: f.x, y: f.y, w: f.w, h: f.h, rotation: f.rotation, z: f.z };
    }
    return selectedItem.layer.transform;
  }, [selectedItem, selectedLayer]);

  // --- Mutate helpers -----------------------------------------------------
  const mutateLayer = useCallback(
    (
      id: string,
      mutator: (l: CanvasLayer) => CanvasLayer,
      options?: { commit?: boolean }
    ) => {
      const prev = overridesRef.current;
      const base: CanvasOverrides = prev
        ? { ...prev, layers: { ...prev.layers }, order: prev.order.slice() }
        : emptyOverrides();
      const seedLayer = base.layers[id] ?? getOrSeedLayer(id);
      if (!seedLayer) return;
      const nextLayer = mutator({
        ...seedLayer,
        transform: { ...seedLayer.transform },
        style: { ...seedLayer.style },
      });
      // BUG-001 — if there's an existing override for this layer and the
      // mutator produced an identical layer, skip both the React state
      // write and the save. Without this guard the iframe (whose `srcDoc`
      // depends on `overrides`) reboots mid-pointer-event for no reason.
      const prevLayer = prev?.layers[id];
      if (prevLayer && shallowLayerEqual(prevLayer, nextLayer)) {
        // Keep overridesRef in sync — but no React state churn.
        return;
      }
      base.layers[id] = nextLayer;
      if (!base.order.includes(id)) base.order.push(id);
      setOverrides(base);
      if (options?.commit !== false) {
        scheduleSave(base, prev);
      }
    },
    [getOrSeedLayer, scheduleSave]
  );

  // Phase 3 (canvas-image-frames). Image-frame mutator. Mirrors `mutateLayer`
  // but writes into `overrides.images`.
  const mutateImage = useCallback(
    (
      id: string,
      framePartial?: Partial<FrameTransform>,
      imagePartial?: Partial<ImageOverride["image"]>,
      options?: { commit?: boolean }
    ) => {
      const prev = overridesRef.current;
      const base: CanvasOverrides = prev
        ? {
            ...prev,
            images: { ...(prev.images ?? {}) },
            order: prev.order.slice(),
            schemaVersion: 2,
          }
        : { layers: {}, images: {}, shapes: {}, order: [], schemaVersion: 2 };
      const seed = base.images?.[id] ?? getOrSeedImage(id);
      if (!seed) return;
      const next: ImageOverride = {
        ...seed,
        frame: { ...seed.frame, ...(framePartial ?? {}) },
        image: { ...seed.image, ...(imagePartial ?? {}) },
      };
      const prevImg = prev?.images?.[id];
      if (prevImg && shallowImageEqual(prevImg, next)) return;
      base.images = { ...(base.images ?? {}), [id]: next };
      if (!base.order.includes(id)) base.order.push(id);
      setOverrides(base);
      if (options?.commit !== false) scheduleSave(base, prev);
    },
    [getOrSeedImage, scheduleSave]
  );

  // Phase 3 (canvas-image-frames). Shape mutator — only frame, no image.
  const mutateShape = useCallback(
    (
      id: string,
      framePartial?: Partial<FrameTransform>,
      options?: { commit?: boolean }
    ) => {
      const prev = overridesRef.current;
      const base: CanvasOverrides = prev
        ? {
            ...prev,
            shapes: { ...(prev.shapes ?? {}) },
            order: prev.order.slice(),
            schemaVersion: 2,
          }
        : { layers: {}, images: {}, shapes: {}, order: [], schemaVersion: 2 };
      const seed = base.shapes?.[id] ?? getOrSeedShape(id);
      if (!seed) return;
      const next: ShapeOverride = {
        ...seed,
        frame: { ...seed.frame, ...(framePartial ?? {}) },
      };
      const prevShape = prev?.shapes?.[id];
      if (prevShape && shallowShapeEqual(prevShape, next)) return;
      base.shapes = { ...(base.shapes ?? {}), [id]: next };
      if (!base.order.includes(id)) base.order.push(id);
      setOverrides(base);
      if (options?.commit !== false) scheduleSave(base, prev);
    },
    [getOrSeedShape, scheduleSave]
  );

  // Phase 3 — throttled image/shape transform sends to the runtime.
  const sendImageTransformThrottled = useMemo(
    () =>
      rafThrottle(
        (
          id: string,
          frame?: Partial<FrameTransform>,
          image?: Partial<ImageOverride["image"]>
        ) => {
          sendRef.current?.({
            type: "oc:editor:apply-image-transform",
            payload: { id, frame, image },
          });
        }
      ),
    []
  );
  useEffect(
    () => () => sendImageTransformThrottled.cancel(),
    [sendImageTransformThrottled]
  );

  const sendShapeTransformThrottled = useMemo(
    () =>
      rafThrottle((id: string, frame?: Partial<FrameTransform>) => {
        sendRef.current?.({
          type: "oc:editor:apply-shape-transform",
          payload: { id, frame },
        });
      }),
    []
  );
  useEffect(
    () => () => sendShapeTransformThrottled.cancel(),
    [sendShapeTransformThrottled]
  );

  // --- Phase 4 (canvas-image-frames): inside-frame mode helpers -----------

  /**
   * Enter inside-frame mode for the named image-frame layer. Selects the
   * frame, flips local mode state, and asks the runtime to switch its
   * cursor + start intercepting pointer/wheel events on that frame's body.
   */
  const enterInsideFrame = useCallback((id: string) => {
    setSelectedId(id);
    setSelectedIds([id]);
    setActiveFrameId(id);
    setCurrentMode("inside-frame");
    sendRef.current?.({
      type: "oc:editor:set-frame-mode",
      payload: { id, mode: "inside-frame" },
    });
  }, []);

  /**
   * Exit inside-frame mode (if we're in it). Notifies the runtime to revert
   * cursor + stop intercepting. Safe to call repeatedly — bails when no
   * inside-frame is active.
   */
  const exitInsideFrame = useCallback(() => {
    if (currentMode !== "inside-frame" || !activeFrameId) return;
    const id = activeFrameId;
    setCurrentMode(null);
    setActiveFrameId(null);
    sendRef.current?.({
      type: "oc:editor:set-frame-mode",
      payload: { id, mode: "frame" },
    });
  }, [currentMode, activeFrameId]);

  // Phase 4: image-frame pan/zoom from runtime. Each event has the FULL
  // image transform (the runtime did the math). We commit immediately —
  // the 350ms debounced PUT collapses bursts into one save naturally.
  const onImagePan = useCallback(
    (p: { id: string; image: ImageOverride["image"] }) => {
      mutateImage(p.id, undefined, p.image, { commit: true });
    },
    [mutateImage]
  );
  const onImageZoom = useCallback(
    (p: { id: string; image: ImageOverride["image"] }) => {
      mutateImage(p.id, undefined, p.image, { commit: true });
    },
    [mutateImage]
  );

  // Inspector "Image inside" segment toggle.
  const onImageFrameModeChange = useCallback(
    (mode: "frame" | "inside-frame") => {
      if (!selectedId || getLayerKind(selectedId) !== "image-frame") return;
      if (mode === "inside-frame") {
        enterInsideFrame(selectedId);
      } else {
        exitInsideFrame();
      }
    },
    [selectedId, getLayerKind, enterInsideFrame, exitInsideFrame]
  );

  // Inspector scale/tx/ty edits in inside-frame mode.
  const onInspectorImageChange = useCallback(
    (image: Partial<ImageOverride["image"]>) => {
      if (!selectedId || getLayerKind(selectedId) !== "image-frame") return;
      mutateImage(selectedId, undefined, image, { commit: true });
      sendRef.current?.({
        type: "oc:editor:apply-image-transform",
        payload: { id: selectedId, image },
      });
    },
    [selectedId, getLayerKind, mutateImage]
  );

  // Inspector "Reset image position" → restore cover-fit calibration.
  const onResetImagePosition = useCallback(() => {
    if (!selectedId || getLayerKind(selectedId) !== "image-frame") return;
    const init = imageInits.get(selectedId);
    if (!init) return;
    mutateImage(selectedId, undefined, init.image, { commit: true });
    sendRef.current?.({
      type: "oc:editor:apply-image-transform",
      payload: { id: selectedId, image: init.image },
    });
  }, [selectedId, getLayerKind, imageInits, mutateImage]);

  // Reset (delete override) for the currently-selected image/shape.
  const onResetSelectedFrame = useCallback(() => {
    if (!selectedId || !selectedItem) return;
    if (selectedItem.kind !== "image-frame" && selectedItem.kind !== "shape") {
      return;
    }
    const prev = overridesRef.current;
    if (!prev) return;
    const base: CanvasOverrides = {
      ...prev,
      images: { ...(prev.images ?? {}) },
      shapes: { ...(prev.shapes ?? {}) },
      order: prev.order.filter((x) => x !== selectedId),
      schemaVersion: 2,
    };
    if (selectedItem.kind === "image-frame") {
      delete base.images![selectedId];
    } else {
      delete base.shapes![selectedId];
    }
    setOverrides(base);
    scheduleSave(base, prev);
    // Re-emit cover-fit by sending the natural rect back to the runtime; the
    // runtime's idempotent guard will restore Claude's original layout.
    if (selectedItem.kind === "image-frame") {
      const init = imageInits.get(selectedId);
      if (init) {
        sendRef.current?.({
          type: "oc:editor:apply-image-transform",
          payload: { id: selectedId, frame: init.frame, image: init.image },
        });
      }
    } else {
      const init = shapeInits.get(selectedId);
      if (init) {
        sendRef.current?.({
          type: "oc:editor:apply-shape-transform",
          payload: { id: selectedId, frame: init.frame },
        });
      }
    }
  }, [selectedId, selectedItem, imageInits, shapeInits, scheduleSave]);

  // Frame change from the inspector (numeric inputs).
  const onInspectorFrameChange = useCallback(
    (framePartial: Partial<FrameTransform>) => {
      if (!selectedId || !selectedItem) return;
      if (selectedItem.kind === "image-frame") {
        mutateImage(selectedId, framePartial, undefined, { commit: true });
        sendImageTransformThrottled(selectedId, framePartial);
      } else if (selectedItem.kind === "shape") {
        mutateShape(selectedId, framePartial, { commit: true });
        sendShapeTransformThrottled(selectedId, framePartial);
      }
    },
    [
      selectedId,
      selectedItem,
      mutateImage,
      mutateShape,
      sendImageTransformThrottled,
      sendShapeTransformThrottled,
    ]
  );

  // --- Iframe message handlers --------------------------------------------
  const onLayout = useCallback((p: { layers: MeasuredLayer[] }) => {
    setLayout(p.layers);
  }, []);

  // Phase 3 (canvas-image-frames). Stash init payloads — the seeders consume
  // these on first edit. Also opportunistically read `<img src>` from the
  // iframe document to populate the inspector thumbnail.
  const onImageFrameInit = useCallback(
    (p: ImageInitPayload) => {
      setImageInits((prev) => {
        if (prev.has(p.id)) return prev;
        const next = new Map(prev);
        next.set(p.id, p);
        return next;
      });
      // Best-effort: pull the original src from the iframe DOM. The iframe
      // lives under `containerRef`. Defer to next tick so the runtime has
      // finished mounting the wrapper element.
      requestAnimationFrame(() => {
        const iframe = containerRef.current?.querySelector(
          "iframe"
        ) as HTMLIFrameElement | null;
        const doc = iframe?.contentDocument;
        if (!doc) return;
        const wrap = doc.querySelector(
          `[data-oc-image-frame="${p.id}"], [data-oc-id="${p.id}"]`
        ) as HTMLElement | null;
        const img = (wrap?.tagName === "IMG"
          ? (wrap as HTMLImageElement)
          : (wrap?.querySelector("img") as HTMLImageElement | null)) as
          | HTMLImageElement
          | null;
        if (img?.src) {
          setImageSrcById((prev) => {
            if (prev.get(p.id) === img.src) return prev;
            const next = new Map(prev);
            next.set(p.id, img.src);
            return next;
          });
        }
      });
    },
    []
  );

  const onShapeInit = useCallback((p: ShapeInitPayload) => {
    setShapeInits((prev) => {
      if (prev.has(p.id)) return prev;
      const next = new Map(prev);
      next.set(p.id, p);
      return next;
    });
  }, []);

  const onReady = useCallback(
    (_p: { slideW: number; slideH: number }) => {
      // Re-apply persisted overrides to the live runtime so dragging from a
      // fresh refine-mode entry sees the right starting positions.
      const send = sendRef.current;
      if (!send || !overridesRef.current) return;
      const ovr = overridesRef.current;
      for (const id of ovr.order) {
        const layer = ovr.layers[id];
        if (layer) {
          send({
            type: "oc:editor:apply-transform",
            payload: { id, transform: layer.transform },
          });
          send({
            type: "oc:editor:apply-style",
            payload: { id, style: layer.style },
          });
          continue;
        }
        // Phase 4 (canvas-image-frames). Re-apply image-frame and shape
        // overrides so pan/zoom/frame state survives a slide reload
        // (guarantee #6).
        const image = ovr.images?.[id];
        if (image) {
          send({
            type: "oc:editor:apply-image-transform",
            payload: { id, frame: image.frame, image: image.image },
          });
          continue;
        }
        const shape = ovr.shapes?.[id];
        if (shape) {
          send({
            type: "oc:editor:apply-shape-transform",
            payload: { id, frame: shape.frame },
          });
        }
      }
    },
    []
  );

  // --- Drag from iframe (body click + drag of a layer) --------------------
  type DragState =
    | {
        kind: "body";
        id: string;
        /** Phase 3 — what kind of layer is being dragged: routes the move
         *  handler to mutateLayer / mutateImage / mutateShape. */
        layerKind: "text" | "image-frame" | "shape";
        startTransform: LayerTransform;
        /** Phase 4 — start transforms for every selected layer at drag-start
         *  so we can apply the same delta in group drag. (Group drag for
         *  Phase 3 only applies to text — image/shape always drag as singletons.) */
        groupStart: Record<string, LayerTransform>;
        /** Initial pointer position in slide coords. */
        startPointer: { x: number; y: number };
      }
    | {
        kind: "handle";
        id: string;
        layerKind: "text" | "image-frame" | "shape";
        info: OverlayDragStart;
      }
    | {
        /** Phase 4 — empty-area drag draws a marquee. */
        kind: "marquee";
        startSlide: { x: number; y: number };
      };
  const dragRef = useRef<DragState | null>(null);
  const dragModifiedRef = useRef(false);
  // Phase 4: each pointer-move stashes the post-snap transform per layer here
  // so pointer-up can persist them in one mutation.
  const lastDragPositionsRef = useRef<Record<string, { x: number; y: number }>>({});

  const onPointerDown = useCallback(
    (p: {
      id: string | null;
      clientX: number;
      clientY: number;
      modifiers: Modifiers;
    }) => {
      // Phase 4 (canvas-image-frames). If we're in inside-frame mode and the
      // user clicked OUTSIDE the active frame (different layer or empty
      // space), exit inside-frame first. The runtime only forwards a
      // pointer-down for clicks outside the active frame's element (clicks
      // INSIDE are intercepted as pan), so reaching this handler at all in
      // inside-frame mode means the user wants out.
      if (
        currentMode === "inside-frame" &&
        activeFrameId &&
        p.id !== activeFrameId
      ) {
        exitInsideFrame();
        // Don't return — fall through to normal selection logic below.
      }

      // Phase 4 — place-text mode: any click drops a fresh layer.
      if (placeMode) {
        const id = generateId();
        const w = 240;
        const h = 60;
        const newLayer: CanvasLayer = {
          id,
          kind: "new",
          transform: {
            x: Math.max(0, p.clientX - w / 2),
            y: Math.max(0, p.clientY - h / 2),
            w,
            h,
            rotation: 0,
            z: 10 + (overridesRef.current?.order.length ?? 0),
          },
          style: { fontSize: 32, color: "#1A4231" },
          text: "Type here",
        };
        const prev = overridesRef.current;
        const base: CanvasOverrides = prev
          ? { ...prev, layers: { ...prev.layers, [id]: newLayer }, order: [...prev.order, id] }
          : { layers: { [id]: newLayer }, order: [id], schemaVersion: 1 };
        setOverrides(base);
        scheduleSave(base, prev);
        sendRef.current?.({ type: "oc:editor:add-layer", payload: { layer: newLayer } });
        sendRef.current?.({ type: "oc:editor:enter-inline-edit", payload: { id } });
        setSelectedId(id);
        setSelectedIds([id]);
        setPlaceMode(false);
        dragRef.current = null;
        return;
      }

      if (p.id == null) {
        // Empty-space click → deselect (unless shift) and start marquee.
        if (!p.modifiers.shift) {
          setSelectedId(null);
          setSelectedIds([]);
        }
        dragRef.current = {
          kind: "marquee",
          startSlide: { x: p.clientX, y: p.clientY },
        };
        dragModifiedRef.current = false;
        return;
      }

      // Phase 4 multi-select logic.
      let nextSel: string[];
      if (p.modifiers.shift) {
        nextSel = selectedIds.includes(p.id)
          ? selectedIds.filter((x) => x !== p.id)
          : [...selectedIds, p.id];
      } else if (selectedIds.includes(p.id)) {
        // Re-clicking inside an existing group selection → preserve group.
        nextSel = selectedIds;
      } else {
        nextSel = [p.id];
      }
      setSelectedIds(nextSel);
      setSelectedId(p.id);

      // Phase 3 (canvas-image-frames). Discriminate the kind to pick the
      // right start transform + later mutator path.
      const k = getLayerKind(p.id);
      let startXf: LayerTransform | null = null;
      if (k === "image-frame") {
        const img = getOrSeedImage(p.id);
        if (img) {
          const f = img.frame;
          startXf = { x: f.x, y: f.y, w: f.w, h: f.h, rotation: f.rotation, z: f.z };
        }
      } else if (k === "shape") {
        const shp = getOrSeedShape(p.id);
        if (shp) {
          const f = shp.frame;
          startXf = { x: f.x, y: f.y, w: f.w, h: f.h, rotation: f.rotation, z: f.z };
        }
      } else {
        const layer = getOrSeedLayer(p.id);
        if (layer) startXf = { ...layer.transform };
      }
      if (!startXf) return;

      // Group-start transforms — only meaningful for text-layer multi-drag.
      const groupStart: Record<string, LayerTransform> = {};
      for (const id of nextSel) {
        const ek = getLayerKind(id);
        if (ek === "text") {
          const l = getOrSeedLayer(id);
          if (l) groupStart[id] = { ...l.transform };
        } else if (ek === "image-frame") {
          const im = getOrSeedImage(id);
          if (im) {
            const f = im.frame;
            groupStart[id] = {
              x: f.x,
              y: f.y,
              w: f.w,
              h: f.h,
              rotation: f.rotation,
              z: f.z,
            };
          }
        } else if (ek === "shape") {
          const sh = getOrSeedShape(id);
          if (sh) {
            const f = sh.frame;
            groupStart[id] = {
              x: f.x,
              y: f.y,
              w: f.w,
              h: f.h,
              rotation: f.rotation,
              z: f.z,
            };
          }
        }
      }
      dragRef.current = {
        kind: "body",
        id: p.id,
        layerKind: k ?? "text",
        startTransform: startXf,
        groupStart,
        startPointer: { x: p.clientX, y: p.clientY },
      };
      dragModifiedRef.current = false;
      lastDragPositionsRef.current = {};
    },
    [
      getLayerKind,
      getOrSeedImage,
      getOrSeedShape,
      getOrSeedLayer,
      placeMode,
      scheduleSave,
      selectedIds,
    ]
  );

  const onPointerMove = useCallback(
    (p: {
      deltaX: number;
      deltaY: number;
      clientX: number;
      clientY: number;
      modifiers: Modifiers;
    }) => {
      const drag = dragRef.current;
      if (!drag) return;

      // Marquee drag — update the rectangle, no layer changes.
      if (drag.kind === "marquee") {
        const start = drag.startSlide;
        const x = Math.min(start.x, p.clientX);
        const y = Math.min(start.y, p.clientY);
        const w = Math.abs(p.clientX - start.x);
        const h = Math.abs(p.clientY - start.y);
        setMarquee({ x, y, w, h });
        dragModifiedRef.current = true;
        return;
      }

      if (drag.kind !== "body") return;

      // BUG-005 — require >3px Manhattan movement before treating this
      // gesture as a drag. Sub-pixel jitter on a click should NOT flip
      // dragModifiedRef → which would otherwise cascade into a phantom
      // setOverrides + iframe reboot (BUG-001/BUG-002).
      if (!dragModifiedRef.current) {
        const totalDx = p.clientX - drag.startPointer.x;
        const totalDy = p.clientY - drag.startPointer.y;
        if (Math.abs(totalDx) + Math.abs(totalDy) <= DRAG_THRESHOLD_PX) {
          return;
        }
      }

      // Phase 4 — snap math against all sibling boxes.
      const otherBoxes = layout
        .filter((l) => !selectedIds.includes(l.id))
        .map((l) => ({ x: l.rect.x, y: l.rect.y, w: l.rect.w, h: l.rect.h }));
      const draggedBox = {
        x: drag.startTransform.x + p.deltaX,
        y: drag.startTransform.y + p.deltaY,
        w: drag.startTransform.w,
        h: drag.startTransform.h,
      };
      const snap = computeSnap({
        dragged: draggedBox,
        others: otherBoxes,
        bounds: { w: slideW, h: slideH },
        disabled: p.modifiers.alt,
      });
      setGuides(snap.guides);

      const dx = snap.snappedX - drag.startTransform.x;
      const dy = snap.snappedY - drag.startTransform.y;
      dragModifiedRef.current = true;

      // Group drag: apply same delta to every selected layer. Each id
      // dispatches via the right mutator based on its kind.
      for (const id of selectedIds) {
        const start = drag.groupStart[id];
        if (!start) continue;
        const next: LayerTransform = {
          ...start,
          x: start.x + dx,
          y: start.y + dy,
        };
        const ek = getLayerKind(id);
        if (ek === "image-frame") {
          sendImageTransformThrottled(id, { x: next.x, y: next.y });
          mutateImage(id, { x: next.x, y: next.y }, undefined, { commit: false });
        } else if (ek === "shape") {
          sendShapeTransformThrottled(id, { x: next.x, y: next.y });
          mutateShape(id, { x: next.x, y: next.y }, { commit: false });
        } else {
          sendTransformThrottled(id, next);
          mutateLayer(id, (l) => ({ ...l, transform: next }), { commit: false });
        }
        lastDragPositionsRef.current[id] = { x: next.x, y: next.y };
      }
    },
    [
      getLayerKind,
      layout,
      mutateLayer,
      mutateImage,
      mutateShape,
      selectedIds,
      sendTransformThrottled,
      sendImageTransformThrottled,
      sendShapeTransformThrottled,
      slideW,
      slideH,
    ]
  );

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setGuides([]);
    if (!drag) return;

    // Marquee finalize: select layers whose bbox intersects the marquee.
    if (drag.kind === "marquee") {
      if (marquee && dragModifiedRef.current) {
        const m = marquee;
        const hits = layout
          .filter((l) =>
            !(
              l.rect.x + l.rect.w < m.x ||
              m.x + m.w < l.rect.x ||
              l.rect.y + l.rect.h < m.y ||
              m.y + m.h < l.rect.y
            )
          )
          .map((l) => l.id);
        setSelectedIds(hits);
        setSelectedId(hits[hits.length - 1] ?? null);
      }
      setMarquee(null);
      return;
    }

    if (!dragModifiedRef.current) return;
    // Flush any pending throttled transform so the iframe sees the final pos.
    sendTransformThrottled.flush();
    sendImageTransformThrottled.flush();
    sendShapeTransformThrottled.flush();
    // Commit: build the final overrides with each layer's final transform and
    // push as ONE undo+save unit. Phase 3 splits the per-id commit by kind.
    const prev = overridesRef.current;
    const base: CanvasOverrides = prev
      ? {
          ...prev,
          layers: { ...prev.layers },
          images: { ...(prev.images ?? {}) },
          shapes: { ...(prev.shapes ?? {}) },
          order: prev.order.slice(),
          schemaVersion: prev.schemaVersion ?? 2,
        }
      : { layers: {}, images: {}, shapes: {}, order: [], schemaVersion: 2 };
    if (drag.kind === "body") {
      for (const id of selectedIds) {
        const finalPos = lastDragPositionsRef.current[id];
        const start = drag.groupStart[id];
        if (!finalPos || !start) continue;
        const ek = getLayerKind(id);
        if (ek === "image-frame") {
          const seed = base.images?.[id] ?? getOrSeedImage(id);
          if (!seed) continue;
          base.images = {
            ...(base.images ?? {}),
            [id]: {
              ...seed,
              frame: { ...seed.frame, x: finalPos.x, y: finalPos.y },
            },
          };
        } else if (ek === "shape") {
          const seed = base.shapes?.[id] ?? getOrSeedShape(id);
          if (!seed) continue;
          base.shapes = {
            ...(base.shapes ?? {}),
            [id]: {
              ...seed,
              frame: { ...seed.frame, x: finalPos.x, y: finalPos.y },
            },
          };
        } else {
          const seed = base.layers[id] ?? getOrSeedLayer(id);
          if (!seed) continue;
          base.layers[id] = {
            ...seed,
            transform: { ...seed.transform, x: finalPos.x, y: finalPos.y },
          };
        }
        if (!base.order.includes(id)) base.order.push(id);
      }
    }
    setOverrides(base);
    scheduleSave(base, prev);
    sendRef.current?.({ type: "oc:editor:re-measure" });
  }, [
    getLayerKind,
    getOrSeedImage,
    getOrSeedShape,
    getOrSeedLayer,
    layout,
    marquee,
    scheduleSave,
    selectedIds,
    sendTransformThrottled,
    sendImageTransformThrottled,
    sendShapeTransformThrottled,
  ]);

  // --- Resize / rotate from SVG overlay -----------------------------------
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.kind !== "handle") return;
      const svgWrap = containerRef.current?.querySelector("svg");
      if (!svgWrap) return;
      const rect = svgWrap.getBoundingClientRect();
      const slideX = (ev.clientX - rect.left) / scale;
      const slideY = (ev.clientY - rect.top) / scale;
      const dx = slideX - drag.info.pointerSlideX;
      const dy = slideY - drag.info.pointerSlideY;
      // BUG-005 — handle drags (resize + rotate) need the same threshold,
      // expressed in slide coords. Skip both the throttled send AND the
      // mutate until the user has actually moved past the dead zone.
      if (!dragModifiedRef.current) {
        if (Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD_PX) {
          return;
        }
      }
      const start = drag.info.startTransform;
      const shift = ev.shiftKey;
      const alt = ev.altKey;

      // Phase 3 (canvas-image-frames). For image-frame corner-handle resize
      // with Shift, lock to the IMAGE's natural aspect (per plan §8). Shape:
      // current frame aspect (existing behavior). Text: current transform aspect.
      let aspectOverride: number | undefined;
      const isCorner =
        drag.info.handle === "nw" ||
        drag.info.handle === "ne" ||
        drag.info.handle === "sw" ||
        drag.info.handle === "se";
      if (shift && isCorner && drag.layerKind === "image-frame") {
        const im = getOrSeedImage(drag.id);
        if (im && im.natural.h > 0) {
          aspectOverride = im.natural.w / im.natural.h;
        }
      }

      const next = computeHandleTransform(
        drag.info.handle,
        start,
        dx,
        dy,
        shift,
        alt,
        slideX,
        slideY,
        aspectOverride
      );
      dragModifiedRef.current = true;

      if (drag.layerKind === "image-frame") {
        sendImageTransformThrottled(
          drag.id,
          { x: next.x, y: next.y, w: next.w, h: next.h, rotation: next.rotation },
          undefined
        );
        mutateImage(
          drag.id,
          { x: next.x, y: next.y, w: next.w, h: next.h, rotation: next.rotation },
          undefined,
          { commit: false }
        );
      } else if (drag.layerKind === "shape") {
        sendShapeTransformThrottled(drag.id, {
          x: next.x,
          y: next.y,
          w: next.w,
          h: next.h,
          rotation: next.rotation,
        });
        mutateShape(
          drag.id,
          { x: next.x, y: next.y, w: next.w, h: next.h, rotation: next.rotation },
          { commit: false }
        );
      } else {
        sendTransformThrottled(drag.id, next);
        mutateLayer(drag.id, (l) => ({ ...l, transform: next }), {
          commit: false,
        });
      }
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (!drag || drag.kind !== "handle") return;
      dragRef.current = null;
      if (!dragModifiedRef.current) return;
      sendTransformThrottled.flush();
      sendImageTransformThrottled.flush();
      sendShapeTransformThrottled.flush();
      if (drag.layerKind === "image-frame") {
        const cur = overridesRef.current?.images?.[drag.id];
        if (cur) mutateImage(drag.id, cur.frame, cur.image, { commit: true });
      } else if (drag.layerKind === "shape") {
        const cur = overridesRef.current?.shapes?.[drag.id];
        if (cur) mutateShape(drag.id, cur.frame, { commit: true });
      } else {
        const cur = overridesRef.current?.layers[drag.id];
        if (cur) {
          mutateLayer(drag.id, (l) => ({ ...l, transform: cur.transform }), {
            commit: true,
          });
        }
      }
      sendRef.current?.({ type: "oc:editor:re-measure" });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [
    mutateLayer,
    mutateImage,
    mutateShape,
    scale,
    sendTransformThrottled,
    sendImageTransformThrottled,
    sendShapeTransformThrottled,
    getOrSeedImage,
  ]);

  const onHandleDown = useCallback(
    (info: OverlayDragStart, _ev: React.PointerEvent) => {
      if (!selectedId) return;
      // Phase 6 — capture layerKind so the move handler routes the resize
      // through the correct mutator (text vs image-frame vs shape). Default
      // to "text" when unknown for back-compat with existing call sites.
      const layerKind = getLayerKind(selectedId) ?? "text";
      dragRef.current = { kind: "handle", id: selectedId, layerKind, info };
      dragModifiedRef.current = false;
    },
    [selectedId, getLayerKind]
  );

  // --- Inspector style change --------------------------------------------
  const onStyleChange = useCallback(
    (style: Partial<LayerStyle>) => {
      if (!selectedId) return;
      mutateLayer(
        selectedId,
        (l) => ({ ...l, style: { ...l.style, ...style } }),
        { commit: true }
      );
      sendRef.current?.({
        type: "oc:editor:apply-style",
        payload: { id: selectedId, style },
      });
    },
    [selectedId, mutateLayer]
  );

  // --- Push selection to runtime so it draws inner outline as well -------
  useEffect(() => {
    sendRef.current?.({
      type: "oc:editor:set-selection",
      payload: { ids: selectedIds },
    });
  }, [selectedIds]);

  // Phase 4: keep selectedId (primary) in sync as last-of selectedIds.
  useEffect(() => {
    if (selectedIds.length === 0) {
      if (selectedId !== null) setSelectedId(null);
    } else if (!selectedIds.includes(selectedId ?? "")) {
      setSelectedId(selectedIds[selectedIds.length - 1]);
    }
  }, [selectedIds, selectedId]);

  // --- Phase 4: inline-text edit (commit on blur from runtime) -----------
  // The runtime sends the original element's computed style alongside the new
  // text so the merged HTML's replica <div> doesn't fall back to browser
  // defaults (16px Times Roman black). We only seed style fields the layer
  // doesn't already override — the user's explicit Inspector edits win.
  const onTextEdit = useCallback(
    (p: {
      id: string;
      text: string;
      computed?: Partial<LayerStyle>;
    }) => {
      mutateLayer(
        p.id,
        (l) => {
          const seededStyle: LayerStyle = { ...(p.computed || {}), ...l.style };
          return { ...l, text: p.text, style: seededStyle };
        },
        { commit: true }
      );
    },
    [mutateLayer]
  );

  // --- Phase 4: layer add / delete / z-order helpers ---------------------
  const deleteLayer = useCallback(
    (id: string) => {
      const prev = overridesRef.current;
      sendRef.current?.({ type: "oc:editor:delete-layer", payload: { id } });
      const base: CanvasOverrides = prev
        ? {
            ...prev,
            layers: { ...prev.layers },
            order: prev.order.filter((x) => x !== id),
          }
        : { layers: {}, order: [], schemaVersion: 1 };
      delete base.layers[id];
      setOverrides(base);
      scheduleSave(base, prev);
      setSelectedIds((cur) => cur.filter((x) => x !== id));
    },
    [scheduleSave]
  );

  const setLayerZ = useCallback(
    (id: string, direction: ZDirection) => {
      sendRef.current?.({
        type: "oc:editor:set-z-order",
        payload: { id, direction },
      });
      const prev = overridesRef.current;
      const seed = prev?.layers[id] ?? getOrSeedLayer(id);
      if (!seed) return;
      const base: CanvasOverrides = prev
        ? { ...prev, layers: { ...prev.layers }, order: prev.order.slice() }
        : { layers: {}, order: [], schemaVersion: 1 };
      if (!base.layers[id]) base.layers[id] = seed;
      const idx = base.order.indexOf(id);
      if (idx >= 0) base.order.splice(idx, 1);
      const insertAt =
        direction === "forward"
          ? Math.min(idx + 1, base.order.length)
          : direction === "back"
            ? Math.max(idx - 1, 0)
            : direction === "top"
              ? base.order.length
              : 0;
      base.order.splice(insertAt, 0, id);
      // Re-stamp z-indices off the order array.
      base.order.forEach((lid, i) => {
        const l = base.layers[lid];
        if (l) base.layers[lid] = { ...l, transform: { ...l.transform, z: 10 + i } };
      });
      setOverrides(base);
      scheduleSave(base, prev);
    },
    [getOrSeedLayer, scheduleSave]
  );

  const duplicateSelection = useCallback(() => {
    if (selectedIds.length === 0) return;
    const prev = overridesRef.current;
    const base: CanvasOverrides = prev
      ? { ...prev, layers: { ...prev.layers }, order: prev.order.slice() }
      : { layers: {}, order: [], schemaVersion: 1 };
    const newIds: string[] = [];
    for (const id of selectedIds) {
      const src = base.layers[id] ?? getOrSeedLayer(id);
      if (!src) continue;
      const newId = generateId();
      newIds.push(newId);
      const dup: CanvasLayer = {
        ...src,
        id: newId,
        kind: "new",
        transform: {
          ...src.transform,
          x: src.transform.x + 20,
          y: src.transform.y + 20,
        },
      };
      base.layers[newId] = dup;
      base.order.push(newId);
      sendRef.current?.({ type: "oc:editor:add-layer", payload: { layer: dup } });
    }
    if (newIds.length > 0) {
      setOverrides(base);
      scheduleSave(base, prev);
      setSelectedIds(newIds);
      setSelectedId(newIds[newIds.length - 1]);
    }
  }, [getOrSeedLayer, scheduleSave, selectedIds]);

  // --- Phase 4: align / distribute --------------------------------------
  const onAlign = useCallback(
    (kind: AlignKind) => {
      if (selectedIds.length < 2) return;
      const layers = selectedIds
        .map((id) => overridesRef.current?.layers[id] ?? getOrSeedLayer(id))
        .filter((l): l is CanvasLayer => !!l);
      if (layers.length < 2) return;
      const minX = Math.min(...layers.map((l) => l.transform.x));
      const minY = Math.min(...layers.map((l) => l.transform.y));
      const maxR = Math.max(...layers.map((l) => l.transform.x + l.transform.w));
      const maxB = Math.max(...layers.map((l) => l.transform.y + l.transform.h));
      const cx = (minX + maxR) / 2;
      const cy = (minY + maxB) / 2;

      const updates: Record<string, { x: number; y: number }> = {};
      if (kind === "left") {
        for (const l of layers) updates[l.id] = { x: minX, y: l.transform.y };
      } else if (kind === "right") {
        for (const l of layers)
          updates[l.id] = { x: maxR - l.transform.w, y: l.transform.y };
      } else if (kind === "h-center") {
        for (const l of layers)
          updates[l.id] = { x: cx - l.transform.w / 2, y: l.transform.y };
      } else if (kind === "top") {
        for (const l of layers) updates[l.id] = { x: l.transform.x, y: minY };
      } else if (kind === "bottom") {
        for (const l of layers)
          updates[l.id] = { x: l.transform.x, y: maxB - l.transform.h };
      } else if (kind === "v-center") {
        for (const l of layers)
          updates[l.id] = { x: l.transform.x, y: cy - l.transform.h / 2 };
      } else if (kind === "distribute-h" && layers.length >= 3) {
        const sorted = [...layers].sort((a, b) => a.transform.x - b.transform.x);
        const total = sorted.reduce((acc, l) => acc + l.transform.w, 0);
        const span =
          sorted[sorted.length - 1].transform.x +
          sorted[sorted.length - 1].transform.w -
          sorted[0].transform.x;
        const gap = (span - total) / (sorted.length - 1);
        let cursor = sorted[0].transform.x;
        for (const l of sorted) {
          updates[l.id] = { x: cursor, y: l.transform.y };
          cursor += l.transform.w + gap;
        }
      } else if (kind === "distribute-v" && layers.length >= 3) {
        const sorted = [...layers].sort((a, b) => a.transform.y - b.transform.y);
        const total = sorted.reduce((acc, l) => acc + l.transform.h, 0);
        const span =
          sorted[sorted.length - 1].transform.y +
          sorted[sorted.length - 1].transform.h -
          sorted[0].transform.y;
        const gap = (span - total) / (sorted.length - 1);
        let cursor = sorted[0].transform.y;
        for (const l of sorted) {
          updates[l.id] = { x: l.transform.x, y: cursor };
          cursor += l.transform.h + gap;
        }
      }

      const prev = overridesRef.current;
      const base: CanvasOverrides = prev
        ? { ...prev, layers: { ...prev.layers }, order: prev.order.slice() }
        : { layers: {}, order: [], schemaVersion: 1 };
      for (const [id, t] of Object.entries(updates)) {
        const seed = base.layers[id] ?? getOrSeedLayer(id);
        if (!seed) continue;
        base.layers[id] = {
          ...seed,
          transform: { ...seed.transform, x: t.x, y: t.y },
        };
        if (!base.order.includes(id)) base.order.push(id);
        sendRef.current?.({
          type: "oc:editor:apply-transform",
          payload: { id, transform: { x: t.x, y: t.y } },
        });
      }
      setOverrides(base);
      scheduleSave(base, prev);
    },
    [getOrSeedLayer, scheduleSave, selectedIds]
  );

  // --- Undo / Redo keyboard shortcuts ------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      const meta = e.metaKey || e.ctrlKey;

      // Cmd+Z / Cmd+Shift+Z
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const snap = e.shiftKey ? undo.redo() : undo.undo();
        if (snap === undefined) return;
        setOverrides(snap);
        const send = sendRef.current;
        if (send && snap) {
          for (const id of snap.order) {
            const layer = snap.layers[id];
            if (!layer) continue;
            send({
              type: "oc:editor:apply-transform",
              payload: { id, transform: layer.transform },
            });
            send({
              type: "oc:editor:apply-style",
              payload: { id, style: layer.style },
            });
          }
          send({ type: "oc:editor:re-measure" });
        }
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        flushSave(snap);
        onOverridesChange?.(snap);
        return;
      }

      // Phase 4 shortcuts ------------------------------------------------
      // T: enter "place new text" mode.
      if (!meta && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        setPlaceMode((v) => !v);
        return;
      }
      // Delete/Backspace: delete selected layers.
      if (!meta && (e.key === "Delete" || e.key === "Backspace")) {
        if (selectedIds.length > 0) {
          e.preventDefault();
          for (const id of [...selectedIds]) deleteLayer(id);
        }
        return;
      }
      // Esc: exit inside-frame mode first if active; otherwise clear
      // selection / exit place mode (existing Phase 4 text behavior).
      if (!meta && e.key === "Escape") {
        e.preventDefault();
        if (currentMode === "inside-frame") {
          exitInsideFrame();
          return;
        }
        setSelectedIds([]);
        setSelectedId(null);
        setPlaceMode(false);
        return;
      }
      // Phase 4 (canvas-image-frames): "0" key in inside-frame mode resets
      // image to cover-fit (the only allowed initial state — see plan §9).
      if (
        !meta &&
        e.key === "0" &&
        currentMode === "inside-frame" &&
        activeFrameId
      ) {
        e.preventDefault();
        const init = imageInits.get(activeFrameId);
        if (init) {
          mutateImage(activeFrameId, undefined, init.image, { commit: true });
          sendRef.current?.({
            type: "oc:editor:apply-image-transform",
            payload: { id: activeFrameId, image: init.image },
          });
        }
        return;
      }
      // Phase 4 (canvas-image-frames): arrow keys in inside-frame mode
      // nudge the IMAGE (tx/ty), not the frame. 1px / 10px with Shift.
      if (
        !meta &&
        currentMode === "inside-frame" &&
        activeFrameId &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown")
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx =
          e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy =
          e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const seed = getOrSeedImage(activeFrameId);
        if (seed) {
          const nextImg = {
            scale: seed.image.scale,
            tx: seed.image.tx + dx,
            ty: seed.image.ty + dy,
          };
          mutateImage(activeFrameId, undefined, nextImg, { commit: true });
          sendRef.current?.({
            type: "oc:editor:apply-image-transform",
            payload: { id: activeFrameId, image: nextImg },
          });
        }
        return;
      }
      // Cmd+]/Cmd+[: bring forward / send back.
      if (meta && (e.key === "]" || e.key === "[")) {
        e.preventDefault();
        const dir: ZDirection = e.key === "]" ? "forward" : "back";
        for (const id of selectedIds) setLayerZ(id, dir);
        return;
      }
      // Cmd+D: duplicate selected.
      if (meta && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      // Arrow keys: nudge.
      if (
        !meta &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown") &&
        selectedIds.length > 0
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx =
          e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy =
          e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const prev = overridesRef.current;
        const base: CanvasOverrides = prev
          ? { ...prev, layers: { ...prev.layers }, order: prev.order.slice() }
          : { layers: {}, order: [], schemaVersion: 1 };
        for (const id of selectedIds) {
          const seed = base.layers[id] ?? getOrSeedLayer(id);
          if (!seed) continue;
          const next = {
            ...seed,
            transform: {
              ...seed.transform,
              x: seed.transform.x + dx,
              y: seed.transform.y + dy,
            },
          };
          base.layers[id] = next;
          if (!base.order.includes(id)) base.order.push(id);
          sendRef.current?.({
            type: "oc:editor:apply-transform",
            payload: { id, transform: { x: next.transform.x, y: next.transform.y } },
          });
        }
        setOverrides(base);
        scheduleSave(base, prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    undo,
    flushSave,
    onOverridesChange,
    selectedIds,
    deleteLayer,
    setLayerZ,
    duplicateSelection,
    getOrSeedLayer,
    scheduleSave,
    currentMode,
    activeFrameId,
    exitInsideFrame,
    imageInits,
    mutateImage,
    getOrSeedImage,
  ]);

  // --- Reset undo stack on slide change ----------------------------------
  useEffect(() => {
    undo.reset();
    setSelectedId(null);
    setOverrides(initialOverrides);
    lastSavedRef.current = JSON.stringify(initialOverrides);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideId]);

  // --- Container size measurement (for SVG overlay sizing) ---------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setContainerSize({ w: r.width, h: r.height });
      }
    };
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    measure();
    return () => obs.disconnect();
  }, []);

  // Compute scale to fit slide into container, mirroring CanvasIframe.
  useEffect(() => {
    if (!containerSize) return;
    const s = Math.min(containerSize.w / slideW, containerSize.h / slideH);
    setScale(s);
  }, [containerSize, slideW, slideH]);

  // --- Render -------------------------------------------------------------
  const scaledW = Math.floor(slideW * scale);
  const scaledH = Math.floor(slideH * scale);
  const overlayWrapperStyle: CSSProperties = {
    position: "absolute",
    width: scaledW,
    height: scaledH,
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
  };

  // Phase 4 — derive layer roster + per-id labels for LayersPanel.
  // The Layers panel + selection lookups need to know about ALL text-leaves
  // the runtime tagged in the iframe — not just ones the user has actively
  // edited. We merge the runtime's layout list with any per-id overrides
  // (overrides win for transform/style; layout supplies the seed for the rest).
  const allLayersInOrder: CanvasLayer[] = useMemo(() => {
    const seen = new Set<string>();
    const out: CanvasLayer[] = [];
    // Runtime-detected layers come first (Claude's authored order).
    for (const m of layout) {
      const ovr = overrides?.layers[m.id];
      if (ovr) {
        out.push(ovr);
      } else {
        out.push({
          id: m.id,
          kind: m.kind,
          transform: {
            x: m.rect.x,
            y: m.rect.y,
            w: m.rect.w,
            h: m.rect.h,
            rotation: 0,
            z: 0,
          },
          style: {},
        });
      }
      seen.add(m.id);
    }
    // Then any override-only layers (newly added via T key, etc.) the runtime
    // hasn't reported yet via layout.
    if (overrides) {
      for (const id of overrides.order) {
        if (seen.has(id)) continue;
        const l = overrides.layers[id];
        if (l) out.push(l);
      }
    }
    return out;
  }, [overrides, layout]);

  // Phase 3 (canvas-image-frames). Adapt the text-layer roster to the
  // discriminated `LayerListEntry` shape the LayersPanel expects, and
  // splice in image-frame / shape entries from overrides + init payloads.
  const allLayerEntries: LayerListEntry[] = useMemo(() => {
    const seen = new Set<string>();
    const out: LayerListEntry[] = [];
    const order = overrides?.order ?? [];
    for (const id of order) {
      if (overrides?.images?.[id]) {
        out.push({ id, kind: "image-frame" });
        seen.add(id);
      } else if (overrides?.shapes?.[id]) {
        out.push({ id, kind: "shape" });
        seen.add(id);
      } else if (overrides?.layers?.[id]) {
        out.push(textLayerToEntry(overrides.layers[id]));
        seen.add(id);
      }
    }
    for (const layer of allLayersInOrder) {
      if (seen.has(layer.id)) continue;
      const k = getLayerKind(layer.id);
      if (k === "image-frame") out.push({ id: layer.id, kind: "image-frame" });
      else if (k === "shape") out.push({ id: layer.id, kind: "shape" });
      else out.push(textLayerToEntry(layer));
      seen.add(layer.id);
    }
    // Image-frame / shape ids that exist only as init payloads (never
    // edited yet) — surface them so the user can select.
    for (const id of imageInits.keys()) {
      if (seen.has(id)) continue;
      out.push({ id, kind: "image-frame" });
      seen.add(id);
    }
    for (const id of shapeInits.keys()) {
      if (seen.has(id)) continue;
      out.push({ id, kind: "shape" });
      seen.add(id);
    }
    return out;
  }, [allLayersInOrder, overrides, imageInits, shapeInits, getLayerKind]);

  const selectedLayers: CanvasLayer[] = useMemo(() => {
    return selectedIds
      .map((id) => overrides?.layers[id] ?? getOrSeedLayer(id))
      .filter((l): l is CanvasLayer => !!l);
  }, [overrides, selectedIds, getOrSeedLayer]);

  const onSelectFromPanel = useCallback(
    (id: string, additive: boolean) => {
      setSelectedIds((cur) => {
        let next: string[];
        if (additive) {
          next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        } else {
          next = [id];
        }
        return next;
      });
      setSelectedId(id);
    },
    []
  );

  return (
    <div className="flex-1 flex min-h-0 min-w-0 bg-[#f0f0f0]">
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="px-4 py-1 text-[11px] uppercase tracking-wide text-accent border-b border-border bg-surface shrink-0 flex items-center gap-3">
          <span>Refine mode</span>
          <span className="text-muted-foreground normal-case tracking-normal">
            Click to select · drag to move · T new text · Del delete · ⌘] / ⌘[ z-order · ⌘D duplicate · ⌘Z undo
          </span>
          {placeMode && (
            <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--brand-yellow)] bg-[var(--brand-green)] px-1.5 py-0.5 rounded">
              Click to place text
            </span>
          )}
        </div>
        <div
          ref={containerRef}
          className="flex-1 relative min-h-0 p-8 px-14"
          style={{ cursor: placeMode ? "crosshair" : undefined }}
        >
          <CanvasIframe
            html={html}
            aspectRatio={aspectRatio}
            overrides={overrides}
            style={{ width: "100%", height: "100%" }}
            onReady={onReady}
            onLayout={onLayout}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onTextEdit={onTextEdit}
            onDoubleClickText={({ id }) => {
              // Phase 4 (canvas-image-frames): dblclick on an image-frame
              // → enter inside-frame mode for pan/zoom. dblclick on text
              // → activate inline edit (existing behavior).
              const k = getLayerKind(id);
              if (k === "image-frame") {
                enterInsideFrame(id);
                return;
              }
              setSelectedId(id);
              setSelectedIds([id]);
              sendRef.current?.({
                type: "oc:editor:enter-inline-edit",
                payload: { id },
              });
            }}
            onImagePan={onImagePan}
            onImageZoom={onImageZoom}
            onImageFrameInit={onImageFrameInit}
            onShapeInit={onShapeInit}
            sendRef={sendRef}
          />
          {scale > 0 && (
            <div style={overlayWrapperStyle}>
              <SelectionOverlay
                transform={selectedFrameTransform}
                kind={
                  currentMode === "inside-frame" &&
                  activeFrameId === selectedId
                    ? "image-frame-inside"
                    : selectedKind
                }
                selectionBoxes={selectedLayers.map((l) => l.transform)}
                guides={guides}
                marquee={marquee}
                scale={scale}
                slideW={slideW}
                slideH={slideH}
                onHandleDown={onHandleDown}
              />
            </div>
          )}
        </div>
      </div>
      <Inspector
        layer={selectedLayer}
        selectedLayers={selectedLayers}
        selectedItem={selectedItem}
        onFrameChange={onInspectorFrameChange}
        onResetFrame={onResetSelectedFrame}
        imageFrameMode={
          selectedItem?.kind === "image-frame" &&
          activeFrameId === selectedId &&
          currentMode === "inside-frame"
            ? "inside-frame"
            : "frame"
        }
        onImageFrameModeChange={onImageFrameModeChange}
        onImageChange={onInspectorImageChange}
        onResetImagePosition={onResetImagePosition}
        onStyleChange={onStyleChange}
        onAlign={onAlign}
        allLayers={allLayerEntries}
        selectedIds={selectedIds}
        onSelectLayer={onSelectFromPanel}
        onDeleteLayer={deleteLayer}
        onZOrderLayer={setLayerZ}
        hasOverrides={
          !!overrides &&
          (Object.keys(overrides.layers).length > 0 ||
            Object.keys(overrides.images ?? {}).length > 0 ||
            Object.keys(overrides.shapes ?? {}).length > 0)
        }
        onResetSlide={() => {
          // Cancel any pending debounced save, then immediately PUT null.
          if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
          }
          setOverrides(null);
          setSelectedId(null);
          setSelectedIds([]);
          flushSave(null);
          onOverridesChange?.(null);
          // Force a fresh iframe boot so it re-walks Claude's HTML cleanly.
          // The simplest way: bump a key that React passes to CanvasIframe.
          // We don't have that wired yet — easiest fallback is a hard reload
          // of the page so the user sees the original immediately.
          window.location.reload();
        }}
      />
      <KeyboardHelpOverlay />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resize math
// ---------------------------------------------------------------------------

function computeHandleTransform(
  handle: HandleId,
  start: LayerTransform,
  dx: number,
  dy: number,
  shift: boolean,
  alt: boolean,
  pointerSlideX: number,
  pointerSlideY: number,
  /**
   * Phase 3 (canvas-image-frames). When set, Shift-aspect lock uses this
   * ratio (w/h) instead of the start transform's aspect. Image-frames pass
   * `natural.w / natural.h` so Shift locks to the source image's aspect
   * rather than any prior crop.
   */
  aspectOverride?: number
): LayerTransform {
  if (handle === "rotate") {
    const cx = start.x + start.w / 2;
    const cy = start.y + start.h / 2;
    let angle = (Math.atan2(pointerSlideY - cy, pointerSlideX - cx) * 180) / Math.PI;
    angle = angle + 90; // pointer at 12 o'clock = 0°
    if (shift) angle = Math.round(angle / 15) * 15;
    return { ...start, rotation: angle };
  }

  let nx = start.x;
  let ny = start.y;
  let nw = start.w;
  let nh = start.h;

  // Each handle adjusts (x, y, w, h) differently. Positive dx/dy = right/down.
  const left = handle === "nw" || handle === "w" || handle === "sw";
  const right = handle === "ne" || handle === "e" || handle === "se";
  const top = handle === "nw" || handle === "n" || handle === "ne";
  const bottom = handle === "sw" || handle === "s" || handle === "se";

  if (left) {
    nx = start.x + dx;
    nw = start.w - dx;
  } else if (right) {
    nw = start.w + dx;
  }
  if (top) {
    ny = start.y + dy;
    nh = start.h - dy;
  } else if (bottom) {
    nh = start.h + dy;
  }

  // Aspect ratio lock — preserve start.w/start.h ratio (or aspectOverride
  // when supplied — Phase 3 image-frame natural-aspect lock). Use the larger
  // of the requested deltas as the driver so the user feels in control.
  if (shift && start.w > 0 && start.h > 0) {
    const ratio =
      aspectOverride && aspectOverride > 0
        ? aspectOverride
        : start.w / start.h;
    if (Math.abs(nw - start.w) > Math.abs(nh - start.h)) {
      const newH = nw / ratio;
      const dh = newH - nh;
      nh = newH;
      if (top) ny -= dh;
    } else {
      const newW = nh * ratio;
      const dw = newW - nw;
      nw = newW;
      if (left) nx -= dw;
    }
  }

  // Resize from center (Alt): keep center fixed.
  if (alt) {
    const cx = start.x + start.w / 2;
    const cy = start.y + start.h / 2;
    nx = cx - nw / 2;
    ny = cy - nh / 2;
  }

  // Don't allow negative w/h.
  if (nw < 4) {
    if (left) nx -= 4 - nw;
    nw = 4;
  }
  if (nh < 4) {
    if (top) ny -= 4 - nh;
    nh = 4;
  }

  return { ...start, x: nx, y: ny, w: nw, h: nh };
}
