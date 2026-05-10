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

const RUNTIME_VERSION = "phase-4-bug-003-004";

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

function tagAndMeasureLayers(): void {
  layerById.clear();
  layerOrder = [];

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
  layerOrder.forEach((id) => {
    const entry = layerById.get(id);
    if (!entry) return;
    entry.rect = measureTextRect(entry.el);
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
  // Walk in reverse layerOrder so top-most layer wins.
  for (let i = layerOrder.length - 1; i >= 0; i--) {
    const id = layerOrder[i];
    const entry = layerById.get(id);
    if (!entry) continue;
    const r = entry.rect;
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
  if (!isDragging) return;
  postToParent("oc:editor:pointer-move", {
    deltaX: ev.clientX - dragStartX,
    deltaY: ev.clientY - dragStartY,
    clientX: ev.clientX,
    clientY: ev.clientY,
    modifiers: modsFromEvent(ev),
  });
}

function onPointerUp(): void {
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
  const layers = layerOrder.map((id) => {
    const entry = layerById.get(id);
    return {
      id: id,
      rect: entry ? entry.rect : { x: 0, y: 0, w: 0, h: 0 },
      kind: entry ? entry.kind : "existing",
    };
  });
  postToParent("oc:editor:layout", { layers: layers });
}

function boot(): void {
  injectSelectionStyles();
  tagAndMeasureLayers();
  sendReady();
  sendLayout();
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerUp, true);
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
