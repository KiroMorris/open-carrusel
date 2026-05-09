/**
 * Editor runtime — Phase 2.
 *
 * This module is COMPILED to a plain-JS string by `scripts/build-editor-runtime.mjs`
 * and injected verbatim inside an inline `<script>` tag by `wrapSlideHtml()`
 * when `editorRuntime: true`. It runs INSIDE the editor iframe (relaxed
 * sandbox: `allow-scripts allow-same-origin`).
 *
 * Constraints:
 *   - No imports. No `import type`. No external deps. Plain TS subset that the
 *     hand-rolled stripper in `scripts/build-editor-runtime.mjs` understands.
 *   - Stays small (~250 lines). Phase 3 will pile features on top of this.
 *
 * Parity requirement (CRITICAL — read before changing):
 *   - `hashLayerId()` below MUST stay byte-stable with `hashLayerId()` in
 *     `src/lib/canvas-overrides.ts`. They use the same cyrb53 + normalize
 *     pipeline. If you change one, you MUST change the other or every
 *     persisted override gets orphaned silently.
 */

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

function hashLayerId(tag: string, cssPath: string, normalizedText: string): string {
  const t = (tag || "").toLowerCase();
  const p = cssPath || "";
  const x = normalizeText(normalizedText || "");
  return "oc-" + hash53(t + "|" + p + "|" + x);
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

/**
 * Heuristic: a "text-bearing leaf" is any element whose own non-whitespace
 * text content is exactly the concatenation of its direct child text nodes
 * (i.e. it doesn't have child elements that themselves carry their own text).
 * That keeps us from tagging container `<div>`s that wrap their own text
 * children, while still catching `<h1>`, `<p>`, `<span>` style leaves.
 */
function isTextLeaf(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) return false;
  let ownText = "";
  let hasChildEl = false;
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 3) {
      ownText += n.nodeValue || "";
    } else if (n.nodeType === 1) {
      hasChildEl = true;
    }
  }
  if (hasChildEl) return false;
  return ownText.replace(/\s+/g, "").length > 0;
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
}

const layerById = new Map<string, LayerEntry>();
let layerOrder: string[] = [];

function tagAndMeasureLayers(): void {
  layerById.clear();
  layerOrder = [];
  const all = document.body.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement;
    if (!isTextLeaf(el)) continue;
    const tag = el.tagName.toLowerCase();
    const path = cssPathOf(el);
    const text = el.textContent || "";
    const id = hashLayerId(tag, path, text);
    if (layerById.has(id)) continue; // collision: keep first
    el.setAttribute("data-oc-layer-id", id);
    const r = el.getBoundingClientRect();
    layerById.set(id, {
      id,
      el,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      kind: "existing",
    });
    layerOrder.push(id);
  }
}

function remeasureAll(): void {
  layerOrder.forEach((id) => {
    const entry = layerById.get(id);
    if (!entry) return;
    const r = entry.el.getBoundingClientRect();
    entry.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
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
  const style = document.createElement("style");
  style.setAttribute("data-oc-editor-style", "1");
  style.textContent =
    "[data-oc-layer-id]." +
    SELECTED_CLASS +
    "{outline:2px solid #2563eb!important;outline-offset:2px!important;}" +
    "[data-oc-layer-id]{cursor:default;}";
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

function applyTransform(id: string, t: AppliedTransform): void {
  const entry = layerById.get(id);
  if (!entry) return;
  const el = entry.el;
  el.style.position = "absolute";
  // Reset visibility in case the original-layout style had hidden it.
  el.style.visibility = "visible";
  if (t.x != null) el.style.left = t.x + "px";
  if (t.y != null) el.style.top = t.y + "px";
  if (t.w != null) el.style.width = t.w + "px";
  if (t.h != null) el.style.height = t.h + "px";
  if (t.rotation != null) el.style.transform = "rotate(" + t.rotation + "deg)";
  if (t.z != null) el.style.zIndex = String(t.z);
  // Refresh cached rect so subsequent hit-tests see the new position.
  const r = el.getBoundingClientRect();
  entry.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
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
  postToParent("oc:editor:text-edit", { id: entry.id, text: text });
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
