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

export interface CanvasOverrides {
  layers: Record<string, CanvasLayer>; // keyed by layer id
  // IDs in render order (bottom -> top). New layers append. Existing layers
  // start in DOM order; reordering bumps `transform.z`. We keep this list
  // separately so we can render new layers at a deterministic position.
  order: string[];
  schemaVersion: 1;
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
