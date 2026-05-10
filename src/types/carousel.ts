export type AspectRatio = "1:1" | "4:5" | "9:16";

export interface LayerTransform {
  x: number;        // px from slide top-left, in slide coords (e.g. 1080-wide)
  y: number;
  w: number;        // px
  h: number;
  rotation: number; // degrees, -180..180
  z: number;        // z-index, integer
}

export interface LayerStyle {
  fontFamily?: string;
  fontSize?: number;       // px
  fontWeight?: number;     // 100..900
  fontStyle?: "normal" | "italic";
  color?: string;          // hex or rgba
  textAlign?: "left" | "center" | "right" | "justify";
  lineHeight?: number;     // unitless
  letterSpacing?: number;  // px
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
}

export type LayerKind = "existing" | "new";

export interface CanvasLayer {
  id: string;                 // stable hash for existing, generated id for new
  kind: LayerKind;
  transform: LayerTransform;
  style: LayerStyle;
  text?: string;              // only set if user edited the text content
                              // (existing layer keeps original text otherwise)
}

// --- Image-frame & shape overrides (Phase 1) --------------------------------

/**
 * Generic frame transform shared by image frames AND non-text "shape" layers
 * (decorative divs, svgs, etc). Coordinates are in slide-local px (e.g. 1080
 * wide for 1:1) — the same coordinate system as `LayerTransform`.
 */
export interface FrameTransform {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number; // degrees, -180..180
  z: number;        // z-index, integer (assigned from `order`)
}

/**
 * The image-inside-frame transform. `scale` multiplies natural dimensions;
 * `tx, ty` are translate values in frame-local px coords.
 */
export interface ImageInnerTransform {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Override for an `<img>` or a `background-image: url(...)` element. Carries
 * the outer frame transform AND the inner image transform (cover-fit math).
 */
export interface ImageOverride {
  id: string;
  kind: "image-frame";
  frame: FrameTransform;
  image: ImageInnerTransform;
  /** Captured `<img>.naturalWidth/Height` (or preloaded background URL dims). */
  natural: { w: number; h: number };
  /**
   * Wrap strategy used at runtime detection time. The export-time splice in
   * `applyOverrides({ mode: "export" })` mirrors this:
   *   "wrapped"    — runtime synthesized a `<div>` wrapper around the `<img>`;
   *                  export emits `<div data-oc-image-frame><img></div>`.
   *   "parent"     — runtime reused the existing parent as the frame; export
   *                  mutates the parent's inline style + the `<img>` inline
   *                  transform in place.
   *   "background" — the framed pixels live in `background-image: url(...)` on
   *                  a `<div>`; export updates `background-size`, `-position`,
   *                  `-repeat:no-repeat` plus the frame transform.
   */
  source: "wrapped" | "parent" | "background";
  /**
   * Captured natural rect of the FRAME element (not the image) when the
   * override was first seeded. Used by export-mode to compute the translate
   * delta from the element's natural in-flow position to its overridden
   * position. Same semantics as the text path's `naturalRect` field.
   */
  naturalFrameRect: { x: number; y: number; w: number; h: number };
}

/**
 * Override for a non-text, non-image-frame layer (decorative div, svg, etc).
 * Only carries the outer frame transform — there's no inner-image to crop and
 * no replica wrapper to emit. Export simply mutates the matched element's
 * inline style with `transform: translate(...) rotate(...); width; height`.
 */
export interface ShapeOverride {
  id: string;
  kind: "shape";
  frame: FrameTransform;
  /**
   * Mirrors `ImageOverride.source`. Shapes never need the wrapper-div
   * strategy, so the legal values are narrower in practice; the field is
   * kept for symmetry and future-proofing.
   */
  source: "wrapped" | "parent";
  /** Captured natural rect at first override; used for translate-from-natural. */
  naturalRect: { x: number; y: number; w: number; h: number };
}

export interface CanvasOverrides {
  layers: Record<string, CanvasLayer>;          // text (existing)
  /**
   * Image-frame overrides (Phase 1). Optional in the type for backward
   * compatibility — `migrateOverrides()` in `src/lib/carousels.ts` normalizes
   * any persisted overrides to include `{}` so storage always has it. Phase
   * 1 call sites that construct fresh overrides in UI code may omit it.
   */
  images?: Record<string, ImageOverride>;
  /**
   * Non-text, non-image-frame "shape" overrides (Phase 1). Optional for the
   * same reason as `images`.
   */
  shapes?: Record<string, ShapeOverride>;
  // IDs in render order (bottom -> top). Unified across all three maps so
  // z-index reasoning works across mixed layer kinds (text + image + shape).
  order: string[];
  /**
   * Schema version. v1 == text-only. v2 == text + image + shape. The disk
   * representation always carries v2 once `migrateOverrides()` has run on
   * read. UI literal `1` is still accepted so existing callers compile.
   */
  schemaVersion: 1 | 2;
}

/**
 * Version-history entry. Legacy entries are bare strings (just the previous
 * HTML); new entries are objects carrying both html and overrides so undo
 * can restore canvas refinement state.
 */
export type SlideVersion =
  | string
  | { html: string; overrides: CanvasOverrides | null };

export interface Slide {
  id: string;
  html: string;
  previousVersions: SlideVersion[];
  order: number;
  notes: string;
  canvasOverrides?: CanvasOverrides | null;
}

export interface ReferenceImage {
  id: string;
  url: string;       // e.g. "/uploads/abc.png"
  absPath: string;    // absolute path for Claude to Read
  name: string;       // original filename or description
  addedAt: string;
}

export interface Carousel {
  id: string;
  name: string;
  aspectRatio: AspectRatio;
  slides: Slide[];
  referenceImages: ReferenceImage[];
  caption?: string;
  hashtags?: string[];
  chatSessionId: string | null;
  isTemplate: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CarouselsData {
  carousels: Carousel[];
}

export const DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
};

export const MAX_SLIDES = 20;
export const MAX_VERSIONS = 5;
