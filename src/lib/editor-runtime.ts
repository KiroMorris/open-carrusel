/**
 * Editor runtime — Phase 4 (BUG-003 / BUG-004 hardening).
 *
 * This module is COMPILED to a plain-JS string by `scripts/build-editor-runtime.mjs`
 * and injected verbatim inside an inline `<script>` tag by `wrapSlideHtml()`
 * when `editorRuntime: true`. It runs INSIDE the editor iframe (relaxed
 * sandbox: `allow-scripts allow-same-origin`).
 *
 * Constraints:
 *   - No imports. No `import type`. No external deps. Plain TS subset that the
 *     hand-rolled stripper in `scripts/build-editor-runtime.mjs` understands.
 *   - Stays small. Phase 4 added idempotent applyTransform and replica/original
 *     id-collision avoidance.
 *
 * Parity requirement (CRITICAL — read before changing):
 *   - `hashLayerId()` below MUST stay byte-stable with `hashLayerId()` in
 *     `src/lib/canvas-overrides.ts`. They use the same cyrb53 + normalize
 *     pipeline. If you change one, you MUST change the other or every
 *     persisted override gets orphaned silently.
 *
 * Contract with `src/lib/canvas-overrides.ts` (BUG-004 fix):
 *   - Replica elements emitted by `applyOverrides` MUST be marked with the
 *     attribute `data-oc-layer-kind` (value "existing" or "new"). The runtime
 *     uses presence of this attribute to distinguish a server-emitted replica
 *     from a Claude-authored element. Replicas keep their pre-set
 *     `data-oc-layer-id`; the runtime never re-hashes their id.
 *   - For text-edited "existing" layers, `applyOverrides` injects a
 *     visibility:hidden CSS rule keyed on `data-oc-layer-id`. That rule will
 *     ALSO match the replica because the replica carries the same id. The
 *     runtime works around this by force-applying `visibility: visible` as an
 *     INLINE style on every replica at boot (inline beats stylesheet
 *     specificity). To make this less hacky, canvas-overrides.ts SHOULD make
 *     its hide-rule selector specific to non-replicas:
 *         `[data-oc-layer-id="X"]:not([data-oc-layer-kind]){visibility:hidden}`
 *     Until that lands, the runtime's inline override keeps the replica
 *     visible.
 */

const RUNTIME_VERSION = "phase-4-inside-frame";

// --- Inlined hash (mirror of src/lib/canvas-overrides.ts) -------------------

function hash53(input: string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(36);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function hashLayerId(tag: string, cssPath: string, _normalizedText?: string): string {
  // Text is intentionally NOT part of the hash — otherwise editing a layer's
  // text would change its id and orphan the persisted override. Keep the
  // signature for API back-compat with existing call sites.
  const t = (tag || "").toLowerCase();
  const p = cssPath || "";
  return "oc-" + hash53(t + "|" + p);
}

// --- DOM walking -------------------------------------------------------------

const SKIP_TAGS = new Set([
  "script",
  "style",
  "img",
  "video",
  "iframe",
  "canvas",
  "audio",
  "svg",
  "noscript",
  "link",
  "meta",
]);

/** Build a deterministic structural path from `body` down to `el`. */
function cssPathOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && cur.parentElement) {
    const parentEl: Element = cur.parentElement;
    let nth = 1;
    let sib: Element | null = cur.previousElementSibling;
    while (sib) {
      if (sib.tagName === cur.tagName) nth++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(cur.tagName.toLowerCase() + ":nth-of-type(" + nth + ")");
    cur = parentEl;
  }
  return parts.join(">");
}

// Inline-formatting tags that don't break a "text-leaf".
const INLINE_TEXT_TAGS = new Set([
  "span", "br", "em", "strong", "b", "i", "u",
  "small", "sup", "sub", "mark", "code", "kbd", "abbr", "wbr",
]);

/**
 * Heuristic: a "text-bearing leaf" is any element that
 *   1. has its OWN direct non-whitespace text content (not just text from
 *      descendants — the element itself must contain a text Node directly),
 *   2. has NO block-level child elements,
 *   3. has measurable visual bounds (skips zero-area / off-screen wrappers).
 *
 * The "own direct text" rule is the important one — it eliminates layout
 * wrappers like `<div class="top">` whose only child is a `<span>` with the
 * actual text. We tag the `<span>`, not the wrapper.
 */
function isTextLeaf(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) return false;
  let ownTextLen = 0;
  let hasBlockChild = false;
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 3) {
      const t = (n.nodeValue || "").replace(/\s+/g, "");
      ownTextLen += t.length;
    } else if (n.nodeType === 1) {
      const tag = (n as Element).tagName.toLowerCase();
      if (!INLINE_TEXT_TAGS.has(tag)) {
        hasBlockChild = true;
        break;
      }
    }
  }
  if (hasBlockChild) return false;
  // Must directly contain at least one non-whitespace text node. This
  // disqualifies pure layout wrappers (`<div class="top">` containing only a
  // `<span>` child) — the span itself will be picked up on the next walk
  // step, with a tight Range-measured bounding box.
  return ownTextLen > 0;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type LayerKind = "existing" | "new";

interface LayerEntry {
  id: string;
  el: HTMLElement;
  rect: Rect;
  kind: LayerKind;
  /** True if user has activated inline edit mode (contenteditable). */
  editing?: boolean;
  /**
   * The element's measured rect at first contact, BEFORE any override-driven
   * translate was applied. Used by `applyTransform` to compute the dx/dy
   * delta from the natural slot — so `transform: translate()` keeps the
   * element in normal flow while still moving visually.
   */
  naturalRect?: Rect;
  /**
   * True once the runtime has actually committed a positional override
   * (position:absolute + left/top/etc) to this element. Until then,
   * `applyTransform` calls that match the cached rect within ~1px are
   * treated as no-ops so authored flex/grid layouts and CSS animations
   * survive.
   */
  absolutized?: boolean;
  /**
   * True when this entry's `el` is a server-emitted replica (its
   * `data-oc-layer-kind` attribute was already set by `applyOverrides`,
   * not by the runtime). Replicas are positioned via inline style by
   * `addLayer`/`applyTransform` and require no flex/grid preservation.
   */
  isReplica?: boolean;
}

const layerById = new Map<string, LayerEntry>();
let layerOrder: string[] = [];

// --- Image / shape entries (Phase 2) ----------------------------------------
//
// Hash-collision invariant: each detected DOM element MUST land in exactly
// ONE of `imageById`, `shapeById`, or `layerById`. Detection runs in this
// order: image-frame → shape → text. A claimed element gets
// `data-oc-runtime-claimed="image"|"shape"|"text"` and subsequent passes
// short-circuit on it. If a hash *value* somehow appears in two maps we
// `console.warn` (defensive against a future cssPath regression).

interface FrameTransformLite {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
}

interface ImageInnerLite {
  scale: number;
  tx: number;
  ty: number;
}

interface ImageEntry {
  id: string;
  /** The wrapping/framing element. Either the synthesized `<div>`, the
   * reused parent, or the same `<div>` whose background-image is the photo. */
  frameEl: HTMLElement;
  /** The `<img>` for "wrapped"/"parent". null for "background". */
  innerEl: HTMLImageElement | null;
  source: "wrapped" | "parent" | "background";
  natural: { w: number; h: number };
  /** Frame's measured rect at first registration, BEFORE any override
   * mutates it. Same role as text path's `naturalRect`. */
  naturalFrameRect: { x: number; y: number; w: number; h: number };
  /** Currently-applied frame transform (slide-local px). */
  frame: FrameTransformLite;
  /** Currently-applied image inner transform. */
  image: ImageInnerLite;
  /** Cached visual rect for hit-test. */
  rect: Rect;
  /** Has any user-driven transform actually been committed? */
  applied?: boolean;
}

interface ShapeEntry {
  id: string;
  el: HTMLElement;
  naturalRect: { x: number; y: number; w: number; h: number };
  frame: FrameTransformLite;
  rect: Rect;
  applied?: boolean;
}

const imageById = new Map<string, ImageEntry>();
const shapeById = new Map<string, ShapeEntry>();

/** Background-image natural-dimension cache, keyed by URL. */
const bgImageNaturalCache = new Map<string, { w: number; h: number } | "pending">();

/**
 * Per-URL callback queue for in-flight preloads. When a URL is requested
 * while it is still "pending" (a previous caller fired off `new Image()` but
 * the load hasn't completed), we push the new caller's `onResolved` here
 * instead of issuing a duplicate `new Image()`. The `finish()` callback in
 * `preloadBackground` drains this queue once dims are known. This keeps the
 * preload to ONE network request per URL even when N elements share it.
 */
const pendingBgCallbacks = new Map<string, Array<() => void>>();

/** Mode state — Phase 4 wires this; Phase 2 only mutates it on message. */
let currentMode: "frame" | "inside-frame" | null = null;
let activeFrameId: string | null = null;

// --- Phase 4: inside-frame pan state ---------------------------------------
//
// When `currentMode === "inside-frame"` AND a pointerdown lands inside the
// active frame's element, we INTERCEPT the event: don't forward
// `oc:editor:pointer-down` (which would trigger frame-mode drag), capture
// the pointer, record the starting image transform + frame-local pointer
// coords, and on subsequent pointermoves update `entry.image.tx, ty` via
// `reclampImageToCover`. Emit `oc:editor:image-pan { id, image }` per move.
let panActive = false;
let panStartImage: ImageInnerLite | null = null;
let panStartCursor: { x: number; y: number } | null = null;
let panFrameRect: { left: number; top: number } | null = null;
let panPointerId: number | null = null;

// --- Geometry helpers (mirror src/lib/geometryHelpers.ts byte-for-byte) -----
// Keep these in sync with the helpers exported there. The runtime can't
// import the module (no bundler in the iframe) so we duplicate. Tests in
// `geometryHelpers.test.ts` lock down the math; if you change one body
// without the other, the tests will catch the drift the next time they run.

function coverFitCalibration(
  natural: { w: number; h: number },
  frame: { w: number; h: number }
): ImageInnerLite {
  if (natural.w <= 0 || natural.h <= 0) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const scale = Math.max(frame.w / natural.w, frame.h / natural.h);
  const renderedW = natural.w * scale;
  const renderedH = natural.h * scale;
  return {
    scale: scale,
    tx: (frame.w - renderedW) / 2,
    ty: (frame.h - renderedH) / 2,
  };
}

function reclampImageToCover(
  image: ImageInnerLite,
  frame: { w: number; h: number },
  natural: { w: number; h: number }
): ImageInnerLite {
  if (natural.w <= 0 || natural.h <= 0) return image;
  const minScale = Math.max(frame.w / natural.w, frame.h / natural.h);
  let scale = image.scale;
  if (scale < minScale) scale = minScale;
  if (scale > 8) scale = 8;
  const renderedW = natural.w * scale;
  const renderedH = natural.h * scale;
  const txMin = frame.w - renderedW;
  const tyMin = frame.h - renderedH;
  let tx = image.tx;
  let ty = image.ty;
  if (tx > 0) tx = 0;
  if (tx < txMin) tx = txMin;
  if (ty > 0) ty = 0;
  if (ty < tyMin) ty = tyMin;
  return { scale: scale, tx: tx, ty: ty };
}

function frameTransformString(
  frame: { x: number; y: number; rotation: number },
  naturalRect: { x: number; y: number }
): string {
  const dx = frame.x - naturalRect.x;
  const dy = frame.y - naturalRect.y;
  const transforms: string[] = [];
  if (dx !== 0 || dy !== 0) transforms.push("translate(" + dx + "px," + dy + "px)");
  if (frame.rotation !== 0) transforms.push("rotate(" + frame.rotation + "deg)");
  return transforms.join(" ");
}

function innerImageTransformString(image: ImageInnerLite): string {
  return (
    "translate(" + image.tx + "px," + image.ty + "px) scale(" + image.scale + ")"
  );
}

// --- RAF throttle (Phase 5) -------------------------------------------------
//
// Inside-frame pan + wheel zoom can fire `pointermove` / `wheel` at trackpad
// frequencies (~120fps). The runtime applies the transform per event AND
// emits an `image-pan` / `image-zoom` postMessage to the parent. Without
// throttling we burn frames doing the math twice and post unnecessarily. The
// parent already debounces saves; we coalesce DOM mutation to one call per
// animation frame here. Uses the same identifier as
// `src/lib/throttle.ts:rafThrottle` for parity but inlined because the
// runtime cannot import the external module.
//
// Used by: `applyImageFrameTransformThrottled` (the throttled wrapper that
// the inside-frame pan/zoom handlers call to avoid the 60fps→120fps doubling).
function rafThrottleRuntime<F extends (...args: never[]) => unknown>(fn: F): F & { flush(): void } {
  let pendingArgs: unknown[] | null = null;
  let scheduled = false;
  const raf =
    typeof requestAnimationFrame !== "undefined"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) =>
          setTimeout(() => cb(Date.now()), 16) as unknown as number;
  function flushFrame() {
    scheduled = false;
    if (pendingArgs) {
      const args = pendingArgs;
      pendingArgs = null;
      (fn as unknown as (...a: unknown[]) => void)(...args);
    }
  }
  const wrapped = function (...args: unknown[]) {
    pendingArgs = args;
    if (!scheduled) {
      scheduled = true;
      raf(flushFrame);
    }
  } as unknown as F & { flush(): void };
  wrapped.flush = () => {
    scheduled = false;
    if (pendingArgs) {
      const args = pendingArgs;
      pendingArgs = null;
      (fn as unknown as (...a: unknown[]) => void)(...args);
    }
  };
  return wrapped;
}

/**
 * Phase 4 — cursor-anchored zoom. Mirror of `cursorAnchoredZoom` in
 * src/lib/geometryHelpers.ts; see geometryHelpers.test.ts for the locked
 * down behavior. Keep the bodies in sync.
 */
function cursorAnchoredZoom(
  prev: ImageInnerLite,
  cursor: { x: number; y: number },
  factor: number,
  natural: { w: number; h: number },
  frame: { w: number; h: number }
): ImageInnerLite {
  if (natural.w <= 0 || natural.h <= 0) return prev;
  if (prev.scale <= 0) return prev;
  const minScale = Math.max(frame.w / natural.w, frame.h / natural.h);
  let newScale = prev.scale * factor;
  if (newScale < minScale) newScale = minScale;
  if (newScale > 8) newScale = 8;
  const cursorImgX = (cursor.x - prev.tx) / prev.scale;
  const cursorImgY = (cursor.y - prev.ty) / prev.scale;
  let tx = cursor.x - cursorImgX * newScale;
  let ty = cursor.y - cursorImgY * newScale;
  const renderedW = natural.w * newScale;
  const renderedH = natural.h * newScale;
  const txMin = frame.w - renderedW;
  const tyMin = frame.h - renderedH;
  if (tx > 0) tx = 0;
  if (tx < txMin) tx = txMin;
  if (ty > 0) ty = 0;
  if (ty < tyMin) ty = tyMin;
  return { scale: newScale, tx: tx, ty: ty };
}

// --- DOM stash + restore (Phase 2) ------------------------------------------
//
// When detection wraps an `<img>` or mutates a parent's overflow, we stash
// the affected element's pre-mount inline style values as JSON in
// `data-oc-original-style`. Phase 3 will wire `restoreStashedStyles()` to
// the refine-mode exit toggle. Phase 2 just guarantees the stash exists.

const STASH_PROPS = [
  "position", "overflow", "overflowX", "overflowY",
  "width", "height", "top", "left", "right", "bottom",
  "margin", "transform", "transformOrigin", "borderRadius",
  "backgroundSize", "backgroundPosition", "backgroundRepeat",
  "maxWidth", "maxHeight",
];

function stashOriginalStyle(el: HTMLElement): void {
  if (el.hasAttribute("data-oc-original-style")) return; // first wins
  const snap: Record<string, string> = {};
  for (let i = 0; i < STASH_PROPS.length; i++) {
    const p = STASH_PROPS[i] as keyof CSSStyleDeclaration;
    const v = (el.style as unknown as Record<string, string>)[p as string];
    if (v != null && v !== "") snap[p as string] = v;
  }
  try {
    el.setAttribute("data-oc-original-style", JSON.stringify(snap));
  } catch {
    // ignore
  }
}

/**
 * Restore every element previously stashed by `stashOriginalStyle()`.
 * NOT wired to anything in Phase 2 — Phase 3 owns the refine-mode exit
 * toggle that calls this. Exported on `window.__ocRuntimeRestore` for
 * manual debugging until then.
 */
function restoreStashedStyles(): void {
  const els = document.querySelectorAll<HTMLElement>("[data-oc-original-style]");
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    let snap: Record<string, string> = {};
    try {
      snap = JSON.parse(el.getAttribute("data-oc-original-style") || "{}");
    } catch {
      // skip malformed
      continue;
    }
    for (let j = 0; j < STASH_PROPS.length; j++) {
      const p = STASH_PROPS[j] as string;
      const styleObj = el.style as unknown as Record<string, string>;
      styleObj[p] = (snap[p] != null ? snap[p] : "");
    }
    el.removeAttribute("data-oc-original-style");
  }
  // For `wrapped` source: unwrap any synthesized wrappers, returning the
  // `<img>` to its original parent.
  const wrappers = document.querySelectorAll<HTMLElement>("[data-oc-image-wrap]");
  for (let i = 0; i < wrappers.length; i++) {
    const wrap = wrappers[i];
    const parent = wrap.parentElement;
    if (!parent) continue;
    while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
    parent.removeChild(wrap);
  }
}

/**
 * Measure an element's TIGHT visual bounds — the union of every text Range
 * inside it. For headings with negative line-height or extra padding this is
 * dramatically tighter than `getBoundingClientRect()` of the layout box, and
 * matches what the user actually sees on screen.
 *
 * Falls back to `getBoundingClientRect()` if Range measurement fails.
 */
function measureTextRect(el: HTMLElement): Rect {
  try {
    let minLeft = Infinity;
    let minTop = Infinity;
    let maxRight = -Infinity;
    let maxBottom = -Infinity;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    let any = false;
    while (node) {
      const txt = (node.nodeValue || "").trim();
      if (txt.length > 0) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          if (r.width === 0 && r.height === 0) continue;
          any = true;
          if (r.left < minLeft) minLeft = r.left;
          if (r.top < minTop) minTop = r.top;
          if (r.right > maxRight) maxRight = r.right;
          if (r.bottom > maxBottom) maxBottom = r.bottom;
        }
      }
      node = walker.nextNode();
    }
    if (any) {
      return {
        x: minLeft,
        y: minTop,
        w: maxRight - minLeft,
        h: maxBottom - minTop,
      };
    }
  } catch {
    // Range API hiccup — fall through to layout box.
  }
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

// --- Image-frame detection (Phase 2) ----------------------------------------

interface DetectedImageFrame {
  source: "wrapped" | "parent";
  frameEl: HTMLElement;
  innerEl: HTMLImageElement;
}

/**
 * Heuristic: a parent qualifies as an "existing frame" iff it has
 * `overflow:hidden` (computed) AND every other child is either zero-area
 * or absolutely-positioned (overlays/badges). The `<img>` is always part
 * of the qualifying-children set as long as it's the only "visual" child.
 */
function isOnlyVisualChild(parent: Element, img: Element): boolean {
  const kids = parent.children;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c === img) continue;
    const r = (c as HTMLElement).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(c as HTMLElement);
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    return false;
  }
  return true;
}

function detectImageFrame(img: HTMLImageElement): DetectedImageFrame {
  const parent = img.parentElement;
  if (parent && parent !== document.body) {
    const cs = getComputedStyle(parent);
    const overflowHidden =
      cs.overflow === "hidden" ||
      cs.overflowX === "hidden" ||
      cs.overflowY === "hidden";
    if (overflowHidden && isOnlyVisualChild(parent, img)) {
      return { source: "parent", frameEl: parent as HTMLElement, innerEl: img };
    }
  }
  // Wrap path. Capture the `<img>`'s pre-mutation visual rect off its
  // computed style so the wrapper inherits the same in-flow position.
  const cs = getComputedStyle(img);
  const wrap = document.createElement("div");
  wrap.setAttribute("data-oc-image-wrap", "1");
  wrap.style.position = cs.position === "static" ? "relative" : cs.position;
  if (cs.top !== "auto") wrap.style.top = cs.top;
  if (cs.left !== "auto") wrap.style.left = cs.left;
  if (cs.right !== "auto") wrap.style.right = cs.right;
  if (cs.bottom !== "auto") wrap.style.bottom = cs.bottom;
  wrap.style.width = cs.width;
  wrap.style.height = cs.height;
  wrap.style.margin = cs.margin;
  wrap.style.overflow = "hidden";
  if (cs.borderRadius && cs.borderRadius !== "0px") {
    wrap.style.borderRadius = cs.borderRadius;
  }
  // Stash the `<img>`'s pre-mount inline styles BEFORE we mutate them.
  stashOriginalStyle(img);
  const ip = img.parentElement;
  if (ip) ip.insertBefore(wrap, img);
  wrap.appendChild(img);
  // Reset `<img>` to absolute fill.
  img.style.position = "absolute";
  img.style.top = "0";
  img.style.left = "0";
  img.style.width = "auto";
  img.style.height = "auto";
  img.style.maxWidth = "none";
  img.style.maxHeight = "none";
  img.style.transformOrigin = "0 0";
  return { source: "wrapped", frameEl: wrap, innerEl: img };
}

/**
 * "Shape-like" element test. Positive list: `svg`, `video`, `iframe`,
 * `embed` always qualify. A `<div>`/`<span>` qualifies iff it has visual
 * presence (non-zero size + non-text styling) and contains no significant
 * own text (otherwise the text-leaf pass should claim it).
 */
function isShapeLayer(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "svg" || tag === "video" || tag === "iframe" || tag === "embed") {
    return true;
  }
  if (tag !== "div" && tag !== "span" && tag !== "section" && tag !== "article" && tag !== "aside" && tag !== "header" && tag !== "footer" && tag !== "main" && tag !== "nav") {
    return false;
  }
  // Has its own non-whitespace text? → not a shape.
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 3) {
      const t = (n.nodeValue || "").replace(/\s+/g, "");
      if (t.length > 0) return false;
    }
  }
  const r = (el as HTMLElement).getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(el as HTMLElement);
  const hasBg = cs.backgroundImage !== "none" || (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent");
  const hasBorder = cs.borderStyle !== "none" && parseFloat(cs.borderWidth) > 0;
  const hasShadow = cs.boxShadow !== "none";
  const hasClip = cs.clipPath !== "none";
  return hasBg || hasBorder || hasShadow || hasClip;
}

/**
 * Extract a single `url(...)` from a computed background-image. Returns null
 * for gradient-only, "none", and SVG-data-URI-only backgrounds.
 *
 * Tolerates:
 *   - quoted (`url("…")`, `url('…')`) and unquoted (`url(…)`)
 *   - sizing/position keywords trailing the url (`url(/x.png) center / cover no-repeat`)
 *   - multi-layer backgrounds where the first non-SVG `url(...)` wins
 *     (e.g. `url(/x.png), linear-gradient(...)`)
 *
 * Mirrors `extractBgUrl` in `src/lib/geometryHelpers.ts`; tests in
 * `geometryHelpers.test.ts` lock down the edge cases.
 */
function extractBgUrl(bg: string | null | undefined): string | null {
  if (!bg) return null;
  const s = String(bg).trim();
  if (!s || s === "none") return null;
  const re = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const url = m[2].trim();
    if (!url) continue;
    if (url.indexOf("data:image/svg") === 0) continue;
    return url;
  }
  return null;
}

/**
 * Preload a background-image URL; resolve with `naturalWidth/Height`, cached
 * by URL across all frames so multiple elements with the same URL share one
 * preload.
 *
 * State per URL in `bgImageNaturalCache`:
 *   - absent       → not yet requested
 *   - "pending"    → preload in flight; queue this caller's onResolved onto
 *                    `pendingBgCallbacks[url]` so it fires once the original
 *                    `new Image()` finishes
 *   - { w, h }     → success — cache hit fires `onResolved` synchronously
 *   - { w:0, h:0 } → failed (404 / CORS) — same synchronous fire; detection
 *                    callers MUST inspect dims and skip frame registration
 *                    when zero
 *
 * Multiple `<div>`s pointing to the same URL share one in-flight preload.
 */
function preloadBackground(url: string, onResolved: () => void): void {
  const cached = bgImageNaturalCache.get(url);
  if (cached !== undefined) {
    if (cached === "pending") {
      const queue = pendingBgCallbacks.get(url) || [];
      queue.push(onResolved);
      pendingBgCallbacks.set(url, queue);
      return;
    }
    onResolved();
    return;
  }
  bgImageNaturalCache.set(url, "pending");
  pendingBgCallbacks.set(url, [onResolved]);
  const img = new Image();
  const finish = (w: number, h: number) => {
    bgImageNaturalCache.set(url, { w: w, h: h });
    const queue = pendingBgCallbacks.get(url) || [];
    pendingBgCallbacks.delete(url);
    for (let i = 0; i < queue.length; i++) {
      try { queue[i](); } catch { /* ignore callback failure */ }
    }
  };
  img.onload = () => finish(img.naturalWidth, img.naturalHeight);
  img.onerror = () => finish(0, 0);
  img.src = url;
}

/** Mark an element as claimed by a particular pass. Returns false if it
 * was already claimed (caller should skip). */
function tryClaim(el: Element, kind: "image" | "shape" | "text"): boolean {
  if (el.hasAttribute("data-oc-runtime-claimed")) return false;
  el.setAttribute("data-oc-runtime-claimed", kind);
  return true;
}

/** Register a single image frame after detection. */
function registerImageFrame(
  img: HTMLImageElement,
  detected: DetectedImageFrame
): { id: string; entry: ImageEntry } | null {
  // Hash off the original `<img>`'s tag + cssPath (NOT the wrapper's path —
  // the wrapper is a runtime synthesis and would never match an export-time
  // splice). Capture the path BEFORE the wrap mutation, but `cssPathOf`
  // walks the live DOM so we must compute it BEFORE detectImageFrame ran.
  // Caller is responsible for passing the pre-wrap path; see Pass A.
  // For wrapped path the parent was mutated, but the `<img>`'s nth-of-type
  // index inside the new wrapper is 1, which differs from its prior nth-
  // of-type. We therefore HASH BEFORE detection — see Pass A below.
  return null; // unused; logic moved inline into Pass A for clarity.
  void img;
  void detected;
}
void registerImageFrame; // silence "unused" until/if we refactor inline pass into helper

/** Detection passes A/B/C. Runs BEFORE the existing text-leaf pass. */
function runImageShapeDetection(): void {
  // -------- Pass A: <img> elements --------
  const imgs = document.body.querySelectorAll<HTMLImageElement>("img");
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    if (img.hasAttribute("data-oc-runtime-claimed")) continue;
    if (img.hasAttribute("data-oc-no-frame")) continue;
    if (img.naturalWidth === 0) {
      // Defer: re-run detection once the image has loaded.
      const handler = () => {
        // Re-run the entire tag pass — cheap and avoids partial-state hazards.
        tagAndMeasureLayers();
        sendLayout();
      };
      img.addEventListener("load", handler, { once: true });
      img.addEventListener("error", handler, { once: true });
      continue;
    }
    // Capture path BEFORE mutation (wrap moves the img into a new parent).
    const tag = "img";
    const path = cssPathOf(img);
    const id = hashLayerId(tag, path);
    if (imageById.has(id) || layerById.has(id) || shapeById.has(id)) {
      // collision — skip
      continue;
    }
    // Special case (landmine #6): `<img>` directly under <body> always uses
    // wrapped strategy (the parent is body; we'd never want to clip body).
    const isTopLevelImg = !path.includes(">");
    let detected: DetectedImageFrame;
    // Capture the FRAME's natural rect BEFORE any mutation.
    let preFrameRect: { x: number; y: number; w: number; h: number };
    if (isTopLevelImg) {
      // Force wrapped. Pre-rect is the <img>'s own rect.
      const r = img.getBoundingClientRect();
      preFrameRect = { x: r.left, y: r.top, w: r.width, h: r.height };
      detected = detectImageFrame(img);
      // detectImageFrame above wraps unconditionally because parent (body)
      // doesn't satisfy isOnlyVisualChild + overflow:hidden. Good.
    } else {
      // Pre-detection: speculatively decide if we'll reuse parent or wrap.
      // Either way we want preFrameRect = the FRAME element's pre-mutation
      // rect, so peek at the heuristic without mutating.
      const parent = img.parentElement;
      const parentCs = parent ? getComputedStyle(parent) : null;
      const parentQualifies =
        !!parent &&
        parent !== document.body &&
        !!parentCs &&
        (parentCs.overflow === "hidden" ||
          parentCs.overflowX === "hidden" ||
          parentCs.overflowY === "hidden") &&
        isOnlyVisualChild(parent, img);
      const futureFrameEl = parentQualifies ? (parent as HTMLElement) : img;
      const r = futureFrameEl.getBoundingClientRect();
      preFrameRect = { x: r.left, y: r.top, w: r.width, h: r.height };
      detected = detectImageFrame(img);
    }
    if (!tryClaim(detected.frameEl, "image")) {
      // Some other pass beat us — bail (shouldn't happen since image runs first).
      continue;
    }
    // Compute initial cover-fit calibration.
    const natural = { w: img.naturalWidth, h: img.naturalHeight };
    const inner = coverFitCalibration(natural, preFrameRect);
    // Apply initial calibration to the inner image (wrapped path needs it
    // because we just reset the `<img>` to absolute fill; without the
    // transform the user would see the natural-size image at top-left).
    detected.innerEl.style.transform = innerImageTransformString(inner);
    detected.innerEl.style.transformOrigin = "0 0";
    const entry: ImageEntry = {
      id: id,
      frameEl: detected.frameEl,
      innerEl: detected.innerEl,
      source: detected.source,
      natural: natural,
      naturalFrameRect: preFrameRect,
      frame: {
        x: preFrameRect.x,
        y: preFrameRect.y,
        w: preFrameRect.w,
        h: preFrameRect.h,
        rotation: 0,
        z: 10,
      },
      image: inner,
      rect: preFrameRect,
    };
    imageById.set(id, entry);
    layerOrder.push(id);
    // Emit init message so parent can seed an ImageOverride on first edit.
    postToParent("oc:editor:image-frame-init", {
      id: id,
      natural: natural,
      source: detected.source,
      frame: entry.frame,
      image: entry.image,
      naturalFrameRect: entry.naturalFrameRect,
    });
  }

  // -------- Pass B: background-image elements --------
  const bgCandidates = document.body.querySelectorAll<HTMLElement>("*");
  for (let i = 0; i < bgCandidates.length; i++) {
    const el = bgCandidates[i];
    if (el.hasAttribute("data-oc-runtime-claimed")) continue;
    if (el.hasAttribute("data-oc-no-frame")) continue;
    // Skip if it has any `<img>` child of its own.
    if (el.querySelector("img")) continue;
    const cs = getComputedStyle(el);
    const url = extractBgUrl(cs.backgroundImage);
    if (!url) continue;
    const cached = bgImageNaturalCache.get(url);
    if (cached === "pending") continue;
    if (!cached) {
      // Kick off preload; re-run when resolved.
      preloadBackground(url, () => {
        tagAndMeasureLayers();
        sendLayout();
      });
      continue;
    }
    if (cached.w === 0 || cached.h === 0) continue; // failed
    const tag = el.tagName.toLowerCase();
    const path = cssPathOf(el);
    const id = hashLayerId(tag, path);
    if (imageById.has(id) || layerById.has(id) || shapeById.has(id)) continue;
    if (!tryClaim(el, "image")) continue;
    stashOriginalStyle(el);
    const r = el.getBoundingClientRect();
    const preFrameRect = { x: r.left, y: r.top, w: r.width, h: r.height };
    const natural = { w: cached.w, h: cached.h };
    const inner = coverFitCalibration(natural, preFrameRect);
    el.style.backgroundSize = natural.w * inner.scale + "px " + natural.h * inner.scale + "px";
    el.style.backgroundPosition = inner.tx + "px " + inner.ty + "px";
    el.style.backgroundRepeat = "no-repeat";
    const entry: ImageEntry = {
      id: id,
      frameEl: el,
      innerEl: null,
      source: "background",
      natural: natural,
      naturalFrameRect: preFrameRect,
      frame: {
        x: preFrameRect.x,
        y: preFrameRect.y,
        w: preFrameRect.w,
        h: preFrameRect.h,
        rotation: 0,
        z: 10,
      },
      image: inner,
      rect: preFrameRect,
    };
    imageById.set(id, entry);
    layerOrder.push(id);
    postToParent("oc:editor:image-frame-init", {
      id: id,
      natural: natural,
      source: "background",
      frame: entry.frame,
      image: entry.image,
      naturalFrameRect: entry.naturalFrameRect,
    });
  }

  // -------- Pass C: shapes --------
  const shapeCandidates = document.body.querySelectorAll<HTMLElement>("*");
  for (let i = 0; i < shapeCandidates.length; i++) {
    const el = shapeCandidates[i];
    if (el.hasAttribute("data-oc-runtime-claimed")) continue;
    if (el.hasAttribute("data-oc-no-frame")) continue;
    if (el.hasAttribute("data-oc-layer-kind")) continue; // server replica
    if (!isShapeLayer(el)) continue;
    const tag = el.tagName.toLowerCase();
    const path = cssPathOf(el);
    const id = hashLayerId(tag, path);
    if (imageById.has(id) || layerById.has(id) || shapeById.has(id)) continue;
    if (!tryClaim(el, "shape")) continue;
    const r = el.getBoundingClientRect();
    const preRect = { x: r.left, y: r.top, w: r.width, h: r.height };
    const entry: ShapeEntry = {
      id: id,
      el: el,
      naturalRect: preRect,
      frame: {
        x: preRect.x,
        y: preRect.y,
        w: preRect.w,
        h: preRect.h,
        rotation: 0,
        z: 10,
      },
      rect: preRect,
    };
    shapeById.set(id, entry);
    layerOrder.push(id);
    postToParent("oc:editor:shape-init", {
      id: id,
      frame: entry.frame,
      naturalRect: entry.naturalRect,
    });
  }
}

function tagAndMeasureLayers(): void {
  layerById.clear();
  imageById.clear();
  shapeById.clear();
  layerOrder = [];
  // Clear any prior claim markers so a re-run discovers afresh.
  const claimed = document.querySelectorAll("[data-oc-runtime-claimed]");
  for (let i = 0; i < claimed.length; i++) {
    claimed[i].removeAttribute("data-oc-runtime-claimed");
  }

  // Phase 2: image-frame + background-image + shape detection BEFORE the
  // existing text-leaf pass. Each detected element is marked claimed so the
  // text pass skips it. (Replicas in pass 1 below also predate this set
  // because they carry data-oc-layer-kind, which the shape pass also skips.)
  runImageShapeDetection();

  // PASS 1 — server-emitted replicas (BUG-004).
  //
  // `applyOverrides` (in canvas-overrides.ts) appends replica <div>s to the
  // body, each carrying BOTH `data-oc-layer-id="X"` AND
  // `data-oc-layer-kind="existing|new"`. These are the live, editable copies.
  // We must:
  //   - register them with their pre-set id (DON'T re-hash),
  //   - mark them as the canonical entry for that id (so the original is
  //     skipped in pass 2 to avoid the BUG-004 id collision),
  //   - force visibility:visible inline (beats the visibility:hidden
  //     stylesheet rule that applyOverrides emits to hide the original;
  //     until that selector is tightened to :not([data-oc-layer-kind]),
  //     the replica would otherwise inherit the same hide rule).
  const replicas = document.body.querySelectorAll<HTMLElement>("[data-oc-layer-kind][data-oc-layer-id]");
  for (let i = 0; i < replicas.length; i++) {
    const el = replicas[i];
    const id = el.getAttribute("data-oc-layer-id") || "";
    const kindAttr = el.getAttribute("data-oc-layer-kind");
    if (!id) continue;
    if (layerById.has(id)) continue;
    // Beat the [data-oc-layer-id="X"]{visibility:hidden} stylesheet rule.
    el.style.setProperty("visibility", "visible", "important");
    const rect = measureTextRect(el);
    layerById.set(id, {
      id,
      el,
      rect,
      kind: kindAttr === "new" ? "new" : "existing",
      isReplica: true,
      // Replicas are already positioned by applyOverrides' inline style;
      // treat them as already-absolutized so subsequent applyTransform
      // calls re-apply faithfully.
      absolutized: true,
    });
    layerOrder.push(id);
  }

  // PASS 2 — Claude-authored elements.
  const all = document.body.querySelectorAll("*");
  // Track elements that are descendants of an already-tagged leaf so we
  // don't tag inline children twice (e.g. tagging <h1> AND its <span>).
  const taggedAncestors: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement;
    // Skip server-emitted replicas — they were handled in pass 1, and we
    // must NEVER re-hash an id that matches a replica or the parent's
    // overrides will key against an orphaned entry (BUG-004).
    if (el.hasAttribute("data-oc-layer-kind")) continue;
    // Phase 2: skip elements claimed by the image/shape passes (BUG-004
    // analog for the new detection space — never tag an element twice).
    if (el.hasAttribute("data-oc-runtime-claimed")) continue;
    if (!isTextLeaf(el)) continue;
    let inside = false;
    for (let j = 0; j < taggedAncestors.length; j++) {
      if (taggedAncestors[j].contains(el) && taggedAncestors[j] !== el) {
        inside = true;
        break;
      }
    }
    if (inside) continue;
    const tag = el.tagName.toLowerCase();
    const path = cssPathOf(el);
    const text = el.textContent || "";
    const id = hashLayerId(tag, path, text);
    // BUG-004: if a replica already owns this id, skip. The replica is the
    // live element; the original stays exactly as Claude authored it
    // (and remains hidden by applyOverrides' stylesheet rule, which is
    // correct because the rule selector matches data-oc-layer-id only —
    // the original keeps its id attribute, the replica's inline
    // visibility:visible override keeps the replica visible).
    if (layerById.has(id)) {
      // Surface a debug breadcrumb so a regression in cssPath uniqueness
      // isn't silently swallowed (S-1 / BUG-019 hygiene).
      try {
        // eslint-disable-next-line no-console
        console.debug("[oc-runtime] layer id collision; keeping first", id, tag, path);
      } catch {
        // ignore
      }
      continue;
    }
    el.setAttribute("data-oc-layer-id", id);
    el.setAttribute("data-oc-runtime-claimed", "text");
    taggedAncestors.push(el);
    const rect = measureTextRect(el);
    // Skip degenerate / off-screen elements (zero-area, negative coords) —
    // they create huge phantom selection boxes when picked up by hit-test.
    if (rect.w <= 0 || rect.h <= 0) {
      el.removeAttribute("data-oc-layer-id");
      taggedAncestors.pop();
      continue;
    }
    layerById.set(id, {
      id,
      el,
      rect,
      kind: "existing",
      absolutized: false,
    });
    layerOrder.push(id);
  }

  // Tag the document so DevTools can verify the right runtime is loaded.
  try {
    document.documentElement.setAttribute("data-oc-runtime-version", RUNTIME_VERSION);
  } catch {
    // ignore
  }
}

function remeasureAll(): void {
  // Use the same Range-based glyph measurement as `measureTextRect()` so
  // re-measuring after a transform produces a tight rect for text leaves
  // whose layout box differs from glyph bounds (BUG-003 hygiene).
  // Image frames + shapes use plain bounding-rect (no glyph subtlety).
  layerOrder.forEach((id) => {
    const t = layerById.get(id);
    if (t) {
      t.rect = measureTextRect(t.el);
      return;
    }
    const im = imageById.get(id);
    if (im) {
      const r = im.frameEl.getBoundingClientRect();
      im.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
      return;
    }
    const sh = shapeById.get(id);
    if (sh) {
      const r = sh.el.getBoundingClientRect();
      sh.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
  });
}

// --- postMessage helpers ----------------------------------------------------

function postToParent(type: string, payload?: unknown): void {
  try {
    parent.postMessage({ type: type, payload: payload }, "*");
  } catch {
    // Parent gone or cross-origin — silently swallow.
  }
}

function isFromParent(ev: MessageEvent): boolean {
  return ev.source !== null && ev.source === parent && ev.source !== window;
}

// --- Hit testing -------------------------------------------------------------

function hitTest(clientX: number, clientY: number): string | null {
  // Walk in reverse layerOrder so top-most layer wins. Phase 2: layerOrder
  // is now a UNION of text + image-frame + shape ids; resolve each by
  // probing all three maps.
  for (let i = layerOrder.length - 1; i >= 0; i--) {
    const id = layerOrder[i];
    let r: Rect | null = null;
    const t = layerById.get(id);
    if (t) r = t.rect;
    else {
      const im = imageById.get(id);
      if (im) r = im.rect;
      else {
        const sh = shapeById.get(id);
        if (sh) r = sh.rect;
      }
    }
    if (!r) continue;
    if (
      clientX >= r.x &&
      clientX <= r.x + r.w &&
      clientY >= r.y &&
      clientY <= r.y + r.h
    ) {
      return id;
    }
  }
  return null;
}

// --- Selection visuals -------------------------------------------------------

const SELECTED_CLASS = "oc-editor-selected";
let currentSelection: string[] = [];

function injectSelectionStyles(): void {
  // The parent's SelectionOverlay (SVG drawn over the iframe) is the
  // single source of truth for visual selection. We used to also draw a
  // blue outline inside the iframe via the .oc-editor-selected class,
  // but it duplicated and clashed with the parent's brand-colored handles.
  // Keep ONLY the cursor hint here.
  const style = document.createElement("style");
  style.setAttribute("data-oc-editor-style", "1");
  style.textContent = "[data-oc-layer-id]{cursor:default;}";
  document.head.appendChild(style);
}

function setSelection(ids: string[]): void {
  currentSelection.forEach((id) => {
    const e = layerById.get(id);
    if (e) e.el.classList.remove(SELECTED_CLASS);
  });
  currentSelection = ids.slice();
  currentSelection.forEach((id) => {
    const e = layerById.get(id);
    if (e) e.el.classList.add(SELECTED_CLASS);
  });
}

// --- Transform application ---------------------------------------------------

interface AppliedTransform {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
  z?: number;
}

/**
 * BUG-003 fix: applyTransform is now idempotent and non-destructive.
 *
 * The OLD implementation unconditionally set `position:absolute`,
 * `visibility:visible`, and `transform: rotate(0deg)` on every call. That
 * blew authored flex/grid children out of layout (because their cached
 * rect was viewport-coords but `left/top` is interpreted relative to the
 * nearest positioned ancestor) AND clobbered authored CSS animations on
 * `transform`.
 *
 * New behaviour:
 *   - If the layer has NEVER been absolutized AND the requested
 *     (x, y, w, h) match the element's current rendered rect within ~1px,
 *     this call is a no-op. The seeded "snapshot" replay on iframe boot
 *     therefore leaves the element in pristine flex/grid flow.
 *   - Once `entry.absolutized` flips true (because the user actually
 *     dragged/resized to coords that DIFFER from the cached rect), all
 *     subsequent applyTransform calls re-apply faithfully.
 *   - `el.style.transform` is only touched when `t.rotation` is a non-zero,
 *     non-null number. A null/undefined/0 rotation leaves any authored
 *     `transform: translate(...)` or `animation: name (transform...)`
 *     untouched. This is imperfect (a deliberate user-set rotation of 0
 *     won't strip an inherited rotate), but is SAFE for the common case.
 *   - `visibility:visible` is only set when the element actually appears
 *     to be hidden — never as a default.
 *   - `z-index` is only set when `t.z != null`. Callers passing `null`/
 *     `undefined` won't drop the layer into a sibling's stacking order.
 */
/**
 * Original-flow movement strategy (BUG-009 fix):
 *
 * The previous design absolutized the element with `position:absolute; left/top`
 * the moment the user committed a positional override. That was lethal for
 * flex/grid children and absolutely-positioned wrappers — leaving the
 * document flow collapsed siblings up into the layer's vacated slot, AND the
 * `left/top` coordinates resolved against the WRONG containing block.
 *
 * New strategy: keep the element in normal flow. Apply visual movement via
 * `transform: translate(dx, dy) [scale(...)] [rotate(...)]`. The original
 * layout slot stays reserved (siblings don't collapse), and the translate is
 * always relative to the element's natural position — independent of what
 * containing block CSS resolves it against.
 *
 * Width/height resize is more invasive (changes layout box). For v1 we
 * accept that: any non-trivial resize sets w/h directly. Sibling reflow on
 * resize is acceptable because resize is rare; movement is the common case.
 *
 * `entry.naturalRect` caches the element's measured rect at first contact,
 * so dx/dy = (override.x - naturalRect.x), etc. This is the only safe way to
 * apply translate without snapping the element to the slide origin.
 */
function applyTransform(id: string, t: AppliedTransform): void {
  const entry = layerById.get(id);
  if (!entry) return;
  const el = entry.el;

  // Capture the natural (un-overridden) rect on first apply so future
  // translate calls always know where the element naturally lives.
  if (!entry.naturalRect) {
    entry.naturalRect = { ...entry.rect };
  }

  const hasPositional =
    t.x != null || t.y != null || t.w != null || t.h != null;

  if (hasPositional) {
    const natural = entry.naturalRect;
    const close = (a: number | null | undefined, b: number): boolean => {
      if (a == null) return true;
      return Math.abs(a - b) <= 1;
    };
    const matchesNatural =
      close(t.x, natural.x) &&
      close(t.y, natural.y) &&
      close(t.w, natural.w) &&
      close(t.h, natural.h);

    if (!matchesNatural) {
      // Compute the translate delta from the natural slot.
      const dx = (t.x != null ? t.x : natural.x) - natural.x;
      const dy = (t.y != null ? t.y : natural.y) - natural.y;
      // Build the transform string. We may need to mix in rotation below.
      const transforms: string[] = [];
      if (dx !== 0 || dy !== 0) {
        transforms.push("translate(" + dx + "px," + dy + "px)");
      }
      if (t.rotation != null && t.rotation !== 0) {
        transforms.push("rotate(" + t.rotation + "deg)");
      }
      if (transforms.length > 0) {
        el.style.transform = transforms.join(" ");
      } else {
        // Both dx/dy are 0 and no rotation — clear our override.
        el.style.transform = "";
      }
      // Resize: only set explicit width/height when the user truly resized.
      // We can't usefully translate-resize text content; set the box dims
      // directly. This may trigger sibling reflow on resize-only edits.
      if (t.w != null && Math.abs(t.w - natural.w) > 1) {
        el.style.width = t.w + "px";
      }
      if (t.h != null && Math.abs(t.h - natural.h) > 1) {
        el.style.height = t.h + "px";
      }
      entry.absolutized = true; // "we have applied an override" — kept for code-path symmetry
    }
    // matchesNatural === true → pure no-op replay; do nothing.
  } else if (t.rotation != null && t.rotation !== 0) {
    // No positional change but rotation was supplied: just set rotate.
    el.style.transform = "rotate(" + t.rotation + "deg)";
  }

  if (t.z != null) el.style.zIndex = String(t.z);

  if (el.style.visibility === "hidden") {
    el.style.visibility = "visible";
  }

  // Refresh cached rect for hit-testing against the NEW visual position.
  entry.rect = measureTextRect(el);
}

interface AppliedStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: string;
  color?: string;
  textAlign?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textTransform?: string;
}

// --- Phase 2: image / shape transform application --------------------------

interface FrameTransformPartial {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
  z?: number;
}

interface ImageInnerPartial {
  scale?: number;
  tx?: number;
  ty?: number;
}

/**
 * Idempotent-guard analog of `applyTransform` for image frames.
 * - Caches `naturalFrameRect` on first apply (already captured at
 *   registration; here we only re-confirm `entry.applied` on commit).
 * - If the frame partial matches `naturalFrameRect` within 1px AND
 *   rotation is 0 AND no image partial is supplied, skip everything.
 * - Otherwise mutate `entry.frame` / `entry.image` and apply via
 *   `transform: translate(...) rotate(...)` (NOT `position:absolute`)
 *   on the frame element, plus the inner-image transform per source.
 */
function applyImageFrameTransform(
  id: string,
  framePartial?: FrameTransformPartial,
  imagePartial?: ImageInnerPartial
): void {
  const entry = imageById.get(id);
  if (!entry) return;
  const close = (a: number | null | undefined, b: number): boolean => {
    if (a == null) return true;
    return Math.abs(a - b) <= 1;
  };
  if (framePartial) {
    if (framePartial.x != null) entry.frame.x = framePartial.x;
    if (framePartial.y != null) entry.frame.y = framePartial.y;
    if (framePartial.w != null) entry.frame.w = framePartial.w;
    if (framePartial.h != null) entry.frame.h = framePartial.h;
    if (framePartial.rotation != null) entry.frame.rotation = framePartial.rotation;
    if (framePartial.z != null) entry.frame.z = framePartial.z;
  }
  // Idempotent skip: matches natural AND no rotation AND no image partial.
  const f = entry.frame;
  const nat = entry.naturalFrameRect;
  const matchesNatural =
    close(f.x, nat.x) &&
    close(f.y, nat.y) &&
    close(f.w, nat.w) &&
    close(f.h, nat.h) &&
    f.rotation === 0;
  if (!entry.applied && matchesNatural && !imagePartial) {
    return;
  }
  if (framePartial) {
    const tStr = frameTransformString(f, nat);
    entry.frameEl.style.transform = tStr;
    if (Math.abs(f.w - nat.w) > 1) entry.frameEl.style.width = f.w + "px";
    if (Math.abs(f.h - nat.h) > 1) entry.frameEl.style.height = f.h + "px";
    if (f.z != null) entry.frameEl.style.zIndex = String(f.z);
    // For "parent" source, ensure overflow:hidden so the inner img clips.
    if (entry.source === "parent" && entry.frameEl.style.overflow !== "hidden") {
      stashOriginalStyle(entry.frameEl);
      entry.frameEl.style.overflow = "hidden";
    }
    entry.applied = true;
  }
  // Always re-clamp image to cover invariant whenever frame OR image changed.
  if (imagePartial) {
    const merged: ImageInnerLite = {
      scale: imagePartial.scale != null ? imagePartial.scale : entry.image.scale,
      tx: imagePartial.tx != null ? imagePartial.tx : entry.image.tx,
      ty: imagePartial.ty != null ? imagePartial.ty : entry.image.ty,
    };
    entry.image = reclampImageToCover(merged, entry.frame, entry.natural);
    entry.applied = true;
  } else if (framePartial) {
    // Frame changed without explicit image partial — re-clamp existing.
    entry.image = reclampImageToCover(entry.image, entry.frame, entry.natural);
  }
  if (entry.source === "background") {
    const renderedW = entry.natural.w * entry.image.scale;
    const renderedH = entry.natural.h * entry.image.scale;
    entry.frameEl.style.backgroundSize = renderedW + "px " + renderedH + "px";
    entry.frameEl.style.backgroundPosition =
      entry.image.tx + "px " + entry.image.ty + "px";
    entry.frameEl.style.backgroundRepeat = "no-repeat";
  } else if (entry.innerEl) {
    entry.innerEl.style.transform = innerImageTransformString(entry.image);
    entry.innerEl.style.transformOrigin = "0 0";
  }
  // Refresh cached rect for hit-test.
  const r = entry.frameEl.getBoundingClientRect();
  entry.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
}

// --- Phase 4: inside-frame mode --------------------------------------------

/**
 * Switch the named image frame between "frame" and "inside-frame" modes.
 *
 * In "inside-frame" mode:
 *   - The frame's cursor becomes `grab` (and `grabbing` while panning).
 *   - The runtime intercepts pointerdown/pointermove/wheel events whose
 *     target lies within the active frame's element (see `onPointerDown`
 *     and `onWheel` below) instead of forwarding them to the parent. This
 *     re-routes user gestures to pan/zoom the IMAGE inside the frame
 *     rather than drag/select the frame itself.
 *
 * In "frame" mode (the default):
 *   - Cursor reverts; events flow through to the parent unchanged. The
 *     frame can be selected, dragged, resized, rotated like any other
 *     layer (Phase 3 handles this).
 *
 * Calling this with an `id` that doesn't exist in `imageById` is a no-op —
 * the parent owns mode state and may briefly request a mode change for an
 * id the runtime hasn't (re)registered after a slide reload.
 */
function setFrameMode(id: string, mode: "frame" | "inside-frame"): void {
  const entry = imageById.get(id);
  if (!entry) return;
  if (mode === "inside-frame") {
    activeFrameId = id;
    currentMode = "inside-frame";
    entry.frameEl.style.cursor = "grab";
  } else {
    if (activeFrameId === id) activeFrameId = null;
    currentMode = "frame";
    entry.frameEl.style.cursor = "";
  }
}

/** True iff `target` is the active frame element OR a descendant of it. */
function isInsideActiveFrame(target: EventTarget | null): boolean {
  if (!activeFrameId || !target) return false;
  const entry = imageById.get(activeFrameId);
  if (!entry) return false;
  if (!(target instanceof Node)) return false;
  return entry.frameEl === target || entry.frameEl.contains(target as Node);
}

/**
 * Wheel handler — intercepts wheel events while in inside-frame mode AND
 * the cursor is over the active frame. Computes a per-event factor and
 * delegates to `cursorAnchoredZoom` (mirror of geometryHelpers.ts) to
 * keep the pixel under the cursor stationary.
 */
function onWheel(ev: WheelEvent): void {
  if (currentMode !== "inside-frame" || !activeFrameId) return;
  if (!isInsideActiveFrame(ev.target)) return;
  const entry = imageById.get(activeFrameId);
  if (!entry) return;
  ev.preventDefault();
  // Factor formula matches plan §9: 1 + deltaY/500, clamped to [0.5, 2].
  // Negative deltaY (wheel up) → factor > 1 → zoom in.
  let factor = 1 - ev.deltaY / 500;
  if (factor < 0.5) factor = 0.5;
  if (factor > 2) factor = 2;
  const rect = entry.frameEl.getBoundingClientRect();
  const cursor = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  const next = cursorAnchoredZoom(
    entry.image,
    cursor,
    factor,
    entry.natural,
    { w: entry.frame.w, h: entry.frame.h }
  );
  // Phase 5: coalesce repeated DOM writes during continuous wheel-zoom to
  // one per animation frame. The math has already run; we just defer the
  // style mutation to the next paint so 120fps trackpad bursts don't double-
  // write per frame.
  applyImageFrameTransformThrottled(activeFrameId, undefined, next);
  // Reflect the just-computed transform into the entry so the postMessage
  // payload is correct (the throttled apply might not have run yet).
  entry.image = reclampImageToCover(next, entry.frame, entry.natural);
  postToParent("oc:editor:image-zoom", { id: activeFrameId, image: entry.image });
}

/**
 * RAF-throttled wrapper around `applyImageFrameTransform`. Use this from the
 * inside-frame pan/zoom hot loops AND from the parent → iframe
 * `apply-image-transform` message handler so we coalesce burst mutations to
 * one DOM write per animation frame (~60fps). Direct calls to
 * `applyImageFrameTransform` still exist for tests and one-shot programmatic
 * resets that need synchronous effect.
 *
 * `.flush()` runs any pending coalesced call immediately — useful at the end
 * of a pan gesture so the final position is committed before the next frame.
 */
const applyImageFrameTransformThrottled = rafThrottleRuntime(
  applyImageFrameTransform as (
    id: string,
    framePartial?: FrameTransformPartial,
    imagePartial?: ImageInnerPartial
  ) => void
);

/**
 * Idempotent-guard analog for shapes — frame transform only, no inner image.
 */
function applyShapeTransform(
  id: string,
  framePartial?: FrameTransformPartial
): void {
  const entry = shapeById.get(id);
  if (!entry) return;
  if (!framePartial) return;
  if (framePartial.x != null) entry.frame.x = framePartial.x;
  if (framePartial.y != null) entry.frame.y = framePartial.y;
  if (framePartial.w != null) entry.frame.w = framePartial.w;
  if (framePartial.h != null) entry.frame.h = framePartial.h;
  if (framePartial.rotation != null) entry.frame.rotation = framePartial.rotation;
  if (framePartial.z != null) entry.frame.z = framePartial.z;
  const f = entry.frame;
  const nat = entry.naturalRect;
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  const matchesNatural =
    close(f.x, nat.x) &&
    close(f.y, nat.y) &&
    close(f.w, nat.w) &&
    close(f.h, nat.h) &&
    f.rotation === 0;
  if (!entry.applied && matchesNatural) return;
  const tStr = frameTransformString(f, nat);
  entry.el.style.transform = tStr;
  if (Math.abs(f.w - nat.w) > 1) entry.el.style.width = f.w + "px";
  if (Math.abs(f.h - nat.h) > 1) entry.el.style.height = f.h + "px";
  if (f.z != null) entry.el.style.zIndex = String(f.z);
  entry.applied = true;
  const r = entry.el.getBoundingClientRect();
  entry.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
}

function applyStyle(id: string, s: AppliedStyle): void {
  const entry = layerById.get(id);
  if (!entry) return;
  const el = entry.el;
  if (s.fontFamily != null) el.style.fontFamily = s.fontFamily;
  if (s.fontSize != null) el.style.fontSize = s.fontSize + "px";
  if (s.fontWeight != null) el.style.fontWeight = String(s.fontWeight);
  if (s.fontStyle != null) el.style.fontStyle = s.fontStyle;
  if (s.color != null) el.style.color = s.color;
  if (s.textAlign != null) el.style.textAlign = s.textAlign;
  if (s.lineHeight != null) el.style.lineHeight = String(s.lineHeight);
  if (s.letterSpacing != null) el.style.letterSpacing = s.letterSpacing + "px";
  if (s.textTransform != null) el.style.textTransform = s.textTransform;
}

// --- Phase 4: add/delete/z-order/text -------------------------------------

interface NewLayerInput {
  id: string;
  kind: LayerKind;
  transform: AppliedTransform & { x: number; y: number; w: number; h: number; rotation: number; z: number };
  style?: AppliedStyle;
  text?: string;
}

function addLayer(layer: NewLayerInput): void {
  if (!layer || !layer.id) return;
  // If a layer with this id already exists (e.g. an "existing" layer being
  // re-added after delete), reveal it instead of duplicating.
  const existing = layerById.get(layer.id);
  if (existing) {
    existing.el.style.display = "";
    existing.el.style.visibility = "visible";
    if (layer.text != null) existing.el.textContent = layer.text;
    applyTransform(layer.id, layer.transform);
    if (layer.style) applyStyle(layer.id, layer.style);
    return;
  }
  const div = document.createElement("div");
  div.setAttribute("data-oc-layer-id", layer.id);
  div.setAttribute("data-oc-layer-kind", layer.kind || "new");
  div.style.position = "absolute";
  div.style.boxSizing = "border-box";
  div.textContent = layer.text || "";
  document.body.appendChild(div);
  const r = div.getBoundingClientRect();
  layerById.set(layer.id, {
    id: layer.id,
    el: div,
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    kind: (layer.kind || "new"),
    // Runtime-created divs are absolute from birth; the next applyTransform
    // call should commit positioning faithfully (no idempotent-skip).
    absolutized: true,
    isReplica: true,
  });
  layerOrder.push(layer.id);
  applyTransform(layer.id, layer.transform);
  if (layer.style) applyStyle(layer.id, layer.style);
}

function deleteLayer(id: string): void {
  const entry = layerById.get(id);
  if (!entry) return;
  if (entry.kind === "new") {
    // Pure absolute overlay — yank from the DOM.
    if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
  } else {
    // Existing Claude-authored element: keep it in DOM but hide so re-show
    // is cheap (and so a future undo can resurrect it).
    entry.el.style.display = "none";
  }
  layerById.delete(id);
  layerOrder = layerOrder.filter((x) => x !== id);
}

function setZOrder(id: string, direction: "forward" | "back" | "top" | "bottom"): void {
  const idx = layerOrder.indexOf(id);
  if (idx < 0) return;
  layerOrder.splice(idx, 1);
  if (direction === "forward") {
    layerOrder.splice(Math.min(idx + 1, layerOrder.length), 0, id);
  } else if (direction === "back") {
    layerOrder.splice(Math.max(idx - 1, 0), 0, id);
  } else if (direction === "top") {
    layerOrder.push(id);
  } else if (direction === "bottom") {
    layerOrder.unshift(id);
  }
  // Reflect into z-index so visual stacking matches.
  layerOrder.forEach((lid, i) => {
    const e = layerById.get(lid);
    if (e) e.el.style.zIndex = String(10 + i);
  });
}

function applyText(id: string, text: string): void {
  const entry = layerById.get(id);
  if (!entry) return;
  if (entry.editing) return; // don't clobber active inline edit
  entry.el.textContent = text;
}

function enterInlineEdit(id: string): void {
  const entry = layerById.get(id);
  if (!entry) return;
  entry.editing = true;
  entry.el.setAttribute("contenteditable", "true");
  // Focus and select all so the user can immediately overtype.
  try {
    entry.el.focus();
    const range = document.createRange();
    range.selectNodeContents(entry.el);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch {
    // ignore selection failures
  }
}

function exitInlineEdit(entry: LayerEntry): void {
  entry.editing = false;
  entry.el.removeAttribute("contenteditable");
  const text = entry.el.textContent || "";
  // Snapshot the original element's computed style so the parent can seed
  // the override's `style` field. Without this, the replica <div> that
  // applyOverrides emits inherits browser defaults (16px Times Roman black)
  // and the edited text looks nothing like the original.
  const cs = window.getComputedStyle(entry.el);
  const computed = {
    fontFamily: cs.fontFamily || undefined,
    fontSize: cs.fontSize ? parseFloat(cs.fontSize) : undefined,
    fontWeight: cs.fontWeight ? parseInt(cs.fontWeight, 10) || undefined : undefined,
    fontStyle: cs.fontStyle === "italic" ? "italic" : "normal",
    color: cs.color || undefined,
    textAlign: cs.textAlign || undefined,
    lineHeight:
      cs.lineHeight && cs.lineHeight !== "normal"
        ? parseFloat(cs.lineHeight) / (parseFloat(cs.fontSize) || 16)
        : undefined,
    letterSpacing:
      cs.letterSpacing && cs.letterSpacing !== "normal"
        ? parseFloat(cs.letterSpacing)
        : undefined,
  };
  postToParent("oc:editor:text-edit", { id: entry.id, text: text, computed: computed });
}

function onBlurCapture(ev: FocusEvent): void {
  const target = ev.target as HTMLElement | null;
  if (!target || !target.getAttribute) return;
  const id = target.getAttribute("data-oc-layer-id");
  if (!id) return;
  const entry = layerById.get(id);
  if (!entry || !entry.editing) return;
  exitInlineEdit(entry);
}

// --- Pointer events ---------------------------------------------------------

interface Modifiers {
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

let dragStartX = 0;
let dragStartY = 0;
let isDragging = false;
let lastDownTimestamp = 0;
let lastDownTargetId: string | null = null;

function modsFromEvent(ev: PointerEvent | MouseEvent): Modifiers {
  return {
    shift: !!ev.shiftKey,
    alt: !!ev.altKey,
    meta: !!(ev.metaKey || ev.ctrlKey),
  };
}

function onPointerDown(ev: PointerEvent): void {
  // Phase 4: inside-frame pan intercept. When in inside-frame mode AND the
  // pointer is inside the active frame's element, capture the gesture as a
  // pan of the IMAGE inside the frame (NOT a drag of the frame). We don't
  // forward `oc:editor:pointer-down` so the parent stays in selection and
  // doesn't try to drag the frame layer.
  if (
    currentMode === "inside-frame" &&
    activeFrameId &&
    isInsideActiveFrame(ev.target)
  ) {
    const entry = imageById.get(activeFrameId);
    if (entry) {
      ev.preventDefault();
      panActive = true;
      panStartImage = { ...entry.image };
      const rect = entry.frameEl.getBoundingClientRect();
      panFrameRect = { left: rect.left, top: rect.top };
      panStartCursor = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      panPointerId = ev.pointerId;
      try {
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
      } catch {
        // setPointerCapture can throw if target is detached — safe to ignore.
      }
      entry.frameEl.style.cursor = "grabbing";
      return;
    }
  }

  const id = hitTest(ev.clientX, ev.clientY);
  // If the user clicks INSIDE a layer that's currently in inline-edit mode,
  // let the browser handle text selection / caret placement — don't start a
  // drag and don't even forward a pointer-down (so the parent doesn't strip
  // selection out from under them).
  if (id) {
    const entry = layerById.get(id);
    if (entry && entry.editing) {
      return;
    }
  }
  dragStartX = ev.clientX;
  dragStartY = ev.clientY;
  isDragging = true;
  postToParent("oc:editor:pointer-down", {
    id: id,
    clientX: ev.clientX,
    clientY: ev.clientY,
    modifiers: modsFromEvent(ev),
  });
  // Track for double-click detection (text layers only).
  const now = Date.now();
  if (id && lastDownTargetId === id && now - lastDownTimestamp < 350) {
    postToParent("oc:editor:dblclick-text", { id: id });
    // Auto-enter inline edit mode so typing works immediately.
    enterInlineEdit(id);
    lastDownTimestamp = 0;
    lastDownTargetId = null;
  } else {
    lastDownTimestamp = now;
    lastDownTargetId = id;
  }
}

function onPointerMove(ev: PointerEvent): void {
  // Phase 4: inside-frame pan. Compute the frame-local cursor delta from
  // the start, apply it to the captured starting image transform, re-clamp
  // to the cover invariant, and emit `oc:editor:image-pan`. NO drag
  // threshold here — pan is fine-grained (the threshold is only for the
  // body-drag-vs-click distinction in frame mode).
  if (panActive && panStartImage && panStartCursor && panFrameRect && activeFrameId) {
    if (panPointerId != null && ev.pointerId !== panPointerId) {
      // Different pointer — ignore (multi-touch case; v1 doesn't handle).
      return;
    }
    const entry = imageById.get(activeFrameId);
    if (!entry) return;
    const cursorX = ev.clientX - panFrameRect.left;
    const cursorY = ev.clientY - panFrameRect.top;
    const dx = cursorX - panStartCursor.x;
    const dy = cursorY - panStartCursor.y;
    const next: ImageInnerLite = {
      scale: panStartImage.scale,
      tx: panStartImage.tx + dx,
      ty: panStartImage.ty + dy,
    };
    const clamped = reclampImageToCover(next, entry.frame, entry.natural);
    // Phase 5: throttle DOM mutation to ~60fps. Trackpad pointermove fires
    // at 120fps; without this we burn paint cycles. We DO update the
    // entry.image ourselves before posting so the parent sees the latest
    // committed values regardless of when the throttled apply runs.
    applyImageFrameTransformThrottled(activeFrameId, undefined, clamped);
    entry.image = clamped;
    postToParent("oc:editor:image-pan", { id: activeFrameId, image: entry.image });
    return;
  }
  if (!isDragging) return;
  postToParent("oc:editor:pointer-move", {
    deltaX: ev.clientX - dragStartX,
    deltaY: ev.clientY - dragStartY,
    clientX: ev.clientX,
    clientY: ev.clientY,
    modifiers: modsFromEvent(ev),
  });
}

function onPointerUp(ev?: PointerEvent): void {
  // Phase 4: end inside-frame pan if active.
  if (panActive) {
    panActive = false;
    panStartImage = null;
    panStartCursor = null;
    panFrameRect = null;
    panPointerId = null;
    // Phase 5: flush any pending throttled DOM update so the final pan
    // position is committed before the next frame (otherwise the user's
    // last move could be lost if the rAF didn't fire before pointer-up).
    try { applyImageFrameTransformThrottled.flush(); } catch { /* noop */ }
    if (activeFrameId) {
      const entry = imageById.get(activeFrameId);
      if (entry) entry.frameEl.style.cursor = "grab";
    }
    if (ev) {
      try {
        (ev.target as Element).releasePointerCapture?.(ev.pointerId);
      } catch {
        // ignore
      }
    }
    return;
  }
  if (!isDragging) return;
  isDragging = false;
  postToParent("oc:editor:pointer-up");
}

// --- Message handler --------------------------------------------------------

function onMessage(ev: MessageEvent): void {
  if (!isFromParent(ev)) return;
  const data = ev.data;
  if (!data || typeof data !== "object") return;
  const type = (data as { type?: string }).type;
  const payload = (data as { payload?: unknown }).payload as Record<string, unknown> | undefined;
  if (type === "oc:editor:init") {
    // Phase 2: acknowledge by re-emitting layout. Phase 3 will diff overrides.
    sendLayout();
  } else if (type === "oc:editor:set-selection") {
    const ids = (payload && Array.isArray(payload.ids) ? payload.ids : []) as string[];
    setSelection(ids);
  } else if (type === "oc:editor:apply-transform") {
    const id = payload && (payload.id as string);
    const transform = payload && (payload.transform as AppliedTransform);
    if (id && transform) applyTransform(id, transform);
  } else if (type === "oc:editor:apply-style") {
    const id = payload && (payload.id as string);
    const style = payload && (payload.style as AppliedStyle);
    if (id && style) applyStyle(id, style);
  } else if (type === "oc:editor:re-measure") {
    sendLayout();
  } else if (type === "oc:editor:add-layer") {
    const layer = payload && (payload.layer as NewLayerInput);
    if (layer) {
      addLayer(layer);
      sendLayout();
    }
  } else if (type === "oc:editor:delete-layer") {
    const id = payload && (payload.id as string);
    if (id) {
      deleteLayer(id);
      sendLayout();
    }
  } else if (type === "oc:editor:set-z-order") {
    const id = payload && (payload.id as string);
    const direction = payload && (payload.direction as "forward" | "back" | "top" | "bottom");
    if (id && direction) setZOrder(id, direction);
  } else if (type === "oc:editor:apply-text") {
    const id = payload && (payload.id as string);
    const text = payload && (payload.text as string);
    if (id && typeof text === "string") applyText(id, text);
  } else if (type === "oc:editor:enter-inline-edit") {
    const id = payload && (payload.id as string);
    if (id) enterInlineEdit(id);
  } else if (type === "oc:editor:apply-image-transform") {
    const id = payload && (payload.id as string);
    const frame = payload && (payload.frame as FrameTransformPartial | undefined);
    const image = payload && (payload.image as ImageInnerPartial | undefined);
    if (id) applyImageFrameTransform(id, frame, image);
  } else if (type === "oc:editor:apply-shape-transform") {
    const id = payload && (payload.id as string);
    const frame = payload && (payload.frame as FrameTransformPartial | undefined);
    if (id) applyShapeTransform(id, frame);
  } else if (type === "oc:editor:set-frame-mode") {
    const id = payload && (payload.id as string);
    const mode = payload && (payload.mode as "frame" | "inside-frame");
    if (id && mode) setFrameMode(id, mode);
  }
}

// --- Boot --------------------------------------------------------------------

function sendReady(): void {
  postToParent("oc:editor:ready", {
    slideW: document.body.clientWidth,
    slideH: document.body.clientHeight,
  });
}

function sendLayout(): void {
  remeasureAll();
  // NOTE: `MeasuredLayer.kind` is still narrowed to LayerKind for Phase 2
  // back-compat (Phase 3 will widen). Image-frame and shape entries are
  // stamped "existing" here; parents disambiguate via the dedicated
  // `image-frame-init` / `shape-init` boot-time messages.
  const layers = layerOrder.map((id) => {
    const t = layerById.get(id);
    if (t) return { id: id, rect: t.rect, kind: t.kind };
    const im = imageById.get(id);
    if (im) return { id: id, rect: im.rect, kind: "existing" };
    const sh = shapeById.get(id);
    if (sh) return { id: id, rect: sh.rect, kind: "existing" };
    return { id: id, rect: { x: 0, y: 0, w: 0, h: 0 }, kind: "existing" };
  });
  postToParent("oc:editor:layout", { layers: layers });
}

function boot(): void {
  injectSelectionStyles();
  tagAndMeasureLayers();
  sendReady();
  sendLayout();
  // Phase 2: expose restore on window for Phase 3 to wire to the refine
  // exit toggle. Until then it's available via DevTools as a manual escape.
  try {
    (window as unknown as { __ocRuntimeRestore?: () => void }).__ocRuntimeRestore = restoreStashedStyles;
  } catch {
    // ignore
  }
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerUp, true);
  // Phase 4: cursor-anchored wheel zoom in inside-frame mode. Capture phase
  // + non-passive so we can preventDefault before the browser scrolls.
  document.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("message", onMessage);
  // Prevent native dragstart on text/images interfering with pointer drag.
  document.addEventListener("dragstart", (e) => e.preventDefault());
  // Inline-edit blur → commit text back to parent.
  document.addEventListener("blur", onBlurCapture, true);
  // Pressing Enter inside contenteditable should commit (blur), not insert
  // a paragraph break — keeps single-line text layers tidy. Shift+Enter
  // still inserts a newline.
  document.addEventListener("keydown", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target || !target.getAttribute) return;
    const id = target.getAttribute("data-oc-layer-id");
    if (!id) return;
    const entry = layerById.get(id);
    if (!entry || !entry.editing) return;
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      target.blur();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      target.blur();
    }
  }, true);
  // Re-measure on resize (zoom etc.).
  window.addEventListener("resize", () => {
    remeasureAll();
    sendLayout();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
