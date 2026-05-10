/**
 * Canvas overrides — pure string-in / string-out transformer that merges a
 * `CanvasOverrides` JSON blob into a slide's body HTML.
 *
 * This module has zero DOM dependency by design — it must run identically in
 * Node (export pipeline) and in the browser (preview iframe + future editor
 * runtime). Both call sites also need to compute layer ids the same way, so
 * the `hashLayerId()` helper is exported and is the ONLY supported way to
 * derive a layer id.
 *
 * Two modes (BUG-021):
 *   - "preview" (default): used by the editor iframe. For existing layers
 *     without a text override, NO replica is emitted — the live runtime
 *     applies transform/style directly on the original element at load time.
 *   - "export":  used by Puppeteer (no runtime at all). For ANY existing
 *     layer with overrides, we ALWAYS emit a replica AND walk the source
 *     HTML to recover the original element's text so the replica is visible.
 */

import type { CanvasLayer, CanvasOverrides, LayerStyle } from "@/types/carousel";

// --- Hashing -----------------------------------------------------------------

/**
 * Deterministic 53-bit FNV-1a-style hash → base36 string.
 * Used by both the editor runtime (to tag DOM nodes) and `applyOverrides()`
 * (to find which DOM nodes the overrides target). MUST stay byte-stable —
 * changing the algorithm orphans every persisted override.
 *
 * PARITY: This function is mirrored verbatim in `src/lib/editor-runtime.ts`
 * (the script that runs inside the editor iframe). Any change here MUST be
 * applied there too, otherwise the runtime will tag DOM nodes with ids that
 * don't match the persisted override keys.
 */
function hash53(input: string): string {
  // cyrb53 — small, fast, no deps; sufficient collision resistance for the
  // ~hundreds-of-layers-per-slide scale we're working at.
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

/**
 * Canonicalize text for hashing: collapse whitespace, trim, lowercase.
 * Two layers with text "  Hello   World " and "hello world" hash the same.
 */
// (Reserved for future use — not part of the current id derivation.)
// function normalizeText(text: string): string {
//   return text.replace(/\s+/g, " ").trim().toLowerCase();
// }

/**
 * Derive a stable layer id from (tag, css-path).
 *
 * - `tag`: lowercase HTML tag name (e.g. `"h1"`, `"div"`).
 * - `cssPath`: a structural path like `"div>div>h1:nth-child(2)"`. The exact
 *   format is up to the caller; what matters is that the editor runtime and
 *   `applyOverrides()` produce the same string for the same node.
 * - `normalizedText`: ignored. Kept in the signature for API back-compat with
 *   the runtime, but text is NOT part of the hash — otherwise editing a
 *   layer's text would change its id and orphan the override (the layer
 *   would visually disappear after each text edit).
 */
export function hashLayerId(
  tag: string,
  cssPath: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  normalizedText?: string
): string {
  const t = (tag ?? "").toLowerCase();
  const p = cssPath ?? "";
  return "oc-" + hash53(`${t}|${p}`);
}

// --- Style serialization -----------------------------------------------------

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function styleToCss(style: LayerStyle): string {
  const parts: string[] = [];
  if (style.fontFamily) parts.push(`font-family:${style.fontFamily}`);
  if (style.fontSize != null) parts.push(`font-size:${style.fontSize}px`);
  if (style.fontWeight != null) parts.push(`font-weight:${style.fontWeight}`);
  if (style.fontStyle) parts.push(`font-style:${style.fontStyle}`);
  if (style.color) parts.push(`color:${style.color}`);
  if (style.textAlign) parts.push(`text-align:${style.textAlign}`);
  if (style.lineHeight != null) parts.push(`line-height:${style.lineHeight}`);
  if (style.letterSpacing != null)
    parts.push(`letter-spacing:${style.letterSpacing}px`);
  if (style.textTransform) parts.push(`text-transform:${style.textTransform}`);
  return parts.join(";");
}

function transformToCss(layer: CanvasLayer, zIndex: number): string {
  const t = layer.transform;
  const styleCss = styleToCss(layer.style);
  // The transform/positioning block is what the layer sits on top of the
  // original layout with. We always emit position:absolute so the layer is
  // taken out of normal flow.
  return [
    "position:absolute",
    `left:${t.x}px`,
    `top:${t.y}px`,
    `width:${t.w}px`,
    `height:${t.h}px`,
    `transform:rotate(${t.rotation}deg)`,
    `z-index:${zIndex}`,
    styleCss,
  ]
    .filter(Boolean)
    .join(";");
}

// --- Minimal HTML scanner (export-mode only) --------------------------------

/**
 * Tags that the runtime's `cssPathOf` walker treats as elements but the
 * runtime's `SKIP_TAGS` excludes from text-leaf consideration. We still need
 * to count them in nth-of-type because the runtime's walker is the same DOM,
 * but for THIS scanner's purposes (recovering text content for a hashed id)
 * we walk every tag the same way `cssPathOf` does.
 *
 * HTML void elements that have no closing tag — must NOT push a stack frame.
 */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

interface ScannedElement {
  tag: string;
  /** css-path computed the same way the runtime does (relative to <body>). */
  cssPath: string;
  /** Inclusive byte offset of `<` in the start tag. */
  startOpen: number;
  /** Exclusive byte offset of `>` ending the start tag. */
  startClose: number;
  /** Inclusive byte offset of `<` of matching close tag, or -1 if void/unknown. */
  endOpen: number;
  /** Exclusive byte offset of `>` of matching close tag, or -1. */
  endClose: number;
  /** Concatenated text-node content inside this element (trimmed). */
  innerText: string;
}

interface StackFrame {
  tag: string;
  cssPath: string;
  startOpen: number;
  startClose: number;
  /** nth-of-type counters for this frame's direct children, keyed by tag. */
  childCounts: Map<string, number>;
  /** Accumulating text content. */
  text: string;
}

/**
 * Walk slide HTML in string mode and collect (tag, cssPath, innerText) per
 * element. The cssPath format MUST match `cssPathOf` in `editor-runtime.ts`
 * so `hashLayerId(tag, cssPath)` matches the ids the runtime generated.
 *
 * Limitations (documented per BUG-021 v1 plan):
 *   - Does not handle malformed HTML (unclosed tags except void elements).
 *   - Treats the slide-html root as if its top-level tags were direct
 *     children of `<body>` — which they are, since `wrapSlideHtml` puts the
 *     slide HTML directly inside `<body>`.
 *   - Comments / CDATA / `<script>` / `<style>` body content are skipped
 *     (their inner text is NOT scanned).
 */
function scanSlideHtml(slideHtml: string): ScannedElement[] {
  const out: ScannedElement[] = [];
  const stack: StackFrame[] = [];
  // Synthetic "body" frame so top-level tags get nth-of-type counted from
  // the body level — matching the runtime's walker which stops at body.
  const root: StackFrame = {
    tag: "body",
    cssPath: "",
    startOpen: -1,
    startClose: -1,
    childCounts: new Map(),
    text: "",
  };
  stack.push(root);

  let i = 0;
  const n = slideHtml.length;
  while (i < n) {
    const ch = slideHtml.charCodeAt(i);
    if (ch !== 60 /* '<' */) {
      // Accumulate text into the current frame.
      const next = slideHtml.indexOf("<", i);
      const end = next === -1 ? n : next;
      const text = slideHtml.slice(i, end);
      if (text.trim()) stack[stack.length - 1].text += text;
      i = end;
      continue;
    }

    // Could be: comment, end-tag, start-tag, or special <!doctype etc.
    if (slideHtml.startsWith("<!--", i)) {
      const close = slideHtml.indexOf("-->", i + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (slideHtml.charCodeAt(i + 1) === 33 /* '!' */) {
      // <!doctype ...> or <![CDATA[
      const close = slideHtml.indexOf(">", i);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (slideHtml.charCodeAt(i + 1) === 47 /* '/' */) {
      // End tag.
      const close = slideHtml.indexOf(">", i);
      if (close === -1) break;
      const tag = slideHtml.slice(i + 2, close).trim().toLowerCase();
      // Pop until we match — tolerate stray closes.
      for (let j = stack.length - 1; j > 0; j--) {
        if (stack[j].tag === tag) {
          // Close everything above j (treat them as auto-closed).
          while (stack.length - 1 > j) {
            const auto = stack.pop()!;
            // Bubble auto-closed text into parent so nothing is lost.
            stack[stack.length - 1].text += auto.text;
            out.push({
              tag: auto.tag,
              cssPath: auto.cssPath,
              startOpen: auto.startOpen,
              startClose: auto.startClose,
              endOpen: -1,
              endClose: -1,
              innerText: auto.text.replace(/\s+/g, " ").trim(),
            });
          }
          const frame = stack.pop()!;
          // Bubble text up so ancestors see descendant text too.
          stack[stack.length - 1].text += frame.text;
          out.push({
            tag: frame.tag,
            cssPath: frame.cssPath,
            startOpen: frame.startOpen,
            startClose: frame.startClose,
            endOpen: i,
            endClose: close + 1,
            innerText: frame.text.replace(/\s+/g, " ").trim(),
          });
          break;
        }
      }
      i = close + 1;
      continue;
    }

    // Start tag (or self-closing).
    // Need to find the matching `>`, but skip `>` inside attribute quotes.
    let j = i + 1;
    let inQuote: 0 | 34 | 39 = 0;
    while (j < n) {
      const c = slideHtml.charCodeAt(j);
      if (inQuote) {
        if (c === inQuote) inQuote = 0;
      } else if (c === 34 || c === 39) {
        inQuote = c as 34 | 39;
      } else if (c === 62 /* '>' */) {
        break;
      }
      j++;
    }
    if (j >= n) break;
    const tagSlice = slideHtml.slice(i + 1, j);
    // Extract tag name (alpha + digits/-).
    const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagSlice);
    if (!m) {
      i = j + 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    const isSelfClose = tagSlice.endsWith("/");
    const isVoid = VOID_ELEMENTS.has(tag);

    // Bump nth-of-type counter under current parent.
    const parent = stack[stack.length - 1];
    const cnt = (parent.childCounts.get(tag) ?? 0) + 1;
    parent.childCounts.set(tag, cnt);
    const part = `${tag}:nth-of-type(${cnt})`;
    const cssPath = parent.cssPath ? `${parent.cssPath}>${part}` : part;

    if (isVoid || isSelfClose) {
      out.push({
        tag,
        cssPath,
        startOpen: i,
        startClose: j + 1,
        endOpen: -1,
        endClose: -1,
        innerText: "",
      });
      i = j + 1;
      continue;
    }

    // Special handling for raw-text elements: <script>, <style>, <textarea>,
    // <title>. Their content is NOT parsed as HTML — skip to matching close.
    if (tag === "script" || tag === "style" || tag === "textarea" || tag === "title") {
      const closeTag = `</${tag}`;
      const closeIdx = slideHtml.toLowerCase().indexOf(closeTag, j + 1);
      const endOpen = closeIdx === -1 ? n : closeIdx;
      const endClose = closeIdx === -1
        ? n
        : (slideHtml.indexOf(">", endOpen) + 1) || n;
      out.push({
        tag,
        cssPath,
        startOpen: i,
        startClose: j + 1,
        endOpen,
        endClose,
        innerText: "",
      });
      i = endClose;
      continue;
    }

    stack.push({
      tag,
      cssPath,
      startOpen: i,
      startClose: j + 1,
      childCounts: new Map(),
      text: "",
    });
    i = j + 1;
  }

  // Auto-close anything left on the stack (other than synthetic body).
  while (stack.length > 1) {
    const frame = stack.pop()!;
    stack[stack.length - 1].text += frame.text;
    out.push({
      tag: frame.tag,
      cssPath: frame.cssPath,
      startOpen: frame.startOpen,
      startClose: frame.startClose,
      endOpen: -1,
      endClose: -1,
      innerText: frame.text.replace(/\s+/g, " ").trim(),
    });
  }

  return out;
}

// --- Public API --------------------------------------------------------------

export interface ApplyOverridesOptions {
  /**
   * "export" mode emits a replica for any existing layer with overrides, so
   * Puppeteer (which doesn't run the editor runtime) sees the user's edits.
   * "preview" mode (default) skips replicas when they'd be empty, because
   * the runtime mutates the original element in place.
   */
  mode?: "preview" | "export";
}

/**
 * Apply overrides to slide body HTML. Pure function; safe in Node + browser.
 *
 * Strategy depends on `mode`:
 *
 *   PREVIEW (default — used by the editor iframe):
 *     - For NEW layers: append a fresh `<div data-oc-layer-id>` at body root.
 *     - For EXISTING layers WITH a text override: emit a replica that
 *       replaces the original glyphs, plus a visibility:hidden rule keyed on
 *       the original's runtime-tagged `data-oc-layer-id` attribute.
 *     - For EXISTING layers WITHOUT a text override: skip — the runtime
 *       mutates the original element in place at load time.
 *
 *   EXPORT (used by `exportSlide` and `exportSlideVideo`):
 *     - Same NEW-layer behavior.
 *     - For EXISTING layers (with OR without text override): scan the source
 *       HTML for the matching element, recover its inner text, and emit a
 *       replica carrying the merged transform/style + recovered text.
 *       Always hide the original (text-override case keeps the same visibility
 *       rule; transform-only also gets it so the original doesn't show
 *       through). If we can't find the original element via the scanner,
 *       fall back to an empty-text replica — visually wrong, but the user
 *       still sees SOMETHING moved at the new coordinates rather than
 *       silently losing the edit.
 *
 * Returns the original `slideHtml` unchanged if `overrides` is null/empty.
 */
export function applyOverrides(
  slideHtml: string,
  overrides: CanvasOverrides | null | undefined,
  options?: ApplyOverridesOptions
): string {
  if (!overrides) return slideHtml;
  // Defensive: tolerate malformed JSON shapes that hand-rolled clients (or
  // accidentally-mutated localStorage) may produce. We treat anything other
  // than a non-null object for `layers` as "no layers".
  const layersObj =
    overrides.layers && typeof overrides.layers === "object"
      ? overrides.layers
      : {};
  const layerIds = Object.keys(layersObj);
  if (layerIds.length === 0) return slideHtml;

  const mode = options?.mode ?? "preview";

  // z-index is derived from `order` so the order array is the source of
  // truth even if individual layers carry stale `transform.z`.
  const orderArr = Array.isArray(overrides.order) ? overrides.order : [];
  const zForId = new Map<string, number>();
  orderArr.forEach((id, idx) => {
    // base z=10 so we sit above Claude's typical layout but below absurd
    // z-index:9999 cases. A layer not in `order` falls through to its own z.
    zForId.set(id, 10 + idx);
  });

  // In export mode, we need to (a) recover the original text for any existing
  // layer that has no `text` override, and (b) inject `data-oc-layer-id` onto
  // the matched original element so the visibility:hidden CSS rule actually
  // hides it (no runtime to tag it for us). Build the scan once.
  let scannedById: Map<string, ScannedElement> | null = null;
  const getScannedById = (): Map<string, ScannedElement> => {
    if (scannedById) return scannedById;
    scannedById = new Map();
    try {
      const scanned = scanSlideHtml(slideHtml);
      for (const el of scanned) {
        const id = hashLayerId(el.tag, el.cssPath);
        if (!scannedById.has(id)) scannedById.set(id, el);
      }
    } catch {
      // Scanner is best-effort; never fail the whole export over it.
    }
    return scannedById;
  };

  // Build the layer markup.
  const layerHtmlParts: string[] = [];
  // IDs of existing layers that need their original element hidden because
  // we're emitting a replica that replaces it.
  const hiddenExistingIds: string[] = [];
  // (export-mode only) For each id we want to hide, the byte offsets of
  // the matched original tag's start, so we can splice in a
  // `data-oc-layer-id="..."` attribute.
  const exportInjections: { id: string; element: ScannedElement }[] = [];

  for (const id of layerIds) {
    const layer = layersObj[id];
    if (!layer || !layer.transform || !layer.style) continue;
    const z = zForId.get(id) ?? layer.transform.z ?? 10;
    const isNew = layer.kind === "new";
    const hasTextOverride = layer.text != null && layer.text !== "";

    let replicaText: string;
    let scannedEl: ScannedElement | undefined;

    if (isNew) {
      replicaText = layer.text != null ? layer.text : "";
    } else if (hasTextOverride) {
      replicaText = layer.text!;
      if (mode === "export") scannedEl = getScannedById().get(id);
    } else if (mode === "export") {
      // Existing layer, no text override, but we're exporting — recover
      // the original text from the source HTML so the replica is visible.
      scannedEl = getScannedById().get(id);
      replicaText = scannedEl?.innerText ?? "";
    } else {
      // mode === "preview", existing layer, no text override → leave the
      // original in place; the runtime applies transform/style to it.
      continue;
    }

    const styleAttr = transformToCss(layer, z);
    const text = escapeHtml(replicaText);
    layerHtmlParts.push(
      `<div data-oc-layer-id="${escapeAttr(id)}" data-oc-layer-kind="${layer.kind}" style="${styleAttr}">${text}</div>`
    );
    if (!isNew) {
      hiddenExistingIds.push(id);
      if (mode === "export" && scannedEl) {
        exportInjections.push({ id, element: scannedEl });
      }
    }
  }

  // Export mode: splice `data-oc-layer-id="..."` into the matched original
  // tags so the visibility:hidden rule below actually hides them. We sort
  // descending by byte offset so each splice doesn't invalidate earlier
  // offsets.
  let mergedSlideHtml = slideHtml;
  if (exportInjections.length > 0) {
    const sorted = exportInjections
      .slice()
      .sort((a, b) => b.element.startClose - a.element.startClose);
    for (const { id, element } of sorted) {
      // startClose is the byte offset just after `>`. The attribute slot is
      // just before that — but if the tag is self-closing (`<br/>`), we
      // need to insert before the trailing `/`. Find the last non-space
      // character before `>` in the original slice.
      const tagSlice = mergedSlideHtml.slice(element.startOpen, element.startClose);
      // Find insertion point inside the tag — right before the closing `>`
      // (or `/>`).
      let insertAt = element.startClose - 1; // position of `>`
      // Walk back over optional `/` and whitespace.
      while (
        insertAt > element.startOpen &&
        (mergedSlideHtml[insertAt - 1] === "/" ||
          mergedSlideHtml[insertAt - 1] === " " ||
          mergedSlideHtml[insertAt - 1] === "\t" ||
          mergedSlideHtml[insertAt - 1] === "\n")
      ) {
        insertAt--;
      }
      // If the tag already has `data-oc-layer-id` (shouldn't, but be safe),
      // skip injection — first-write-wins.
      if (/data-oc-layer-id\s*=/.test(tagSlice)) continue;
      const injected = ` data-oc-layer-id="${escapeAttr(id)}"`;
      mergedSlideHtml =
        mergedSlideHtml.slice(0, insertAt) +
        injected +
        mergedSlideHtml.slice(insertAt);
    }
  }

  // Hide-original block: any existing layer we're actively replacing gets
  // visibility:hidden so the original doesn't bleed through under the replica.
  const overriddenIdsCss = hiddenExistingIds
    .map((id) => `[data-oc-layer-id="${id.replace(/"/g, '\\"')}"]`)
    .join(",");
  const hideOriginalsBlock = overriddenIdsCss
    ? `<style data-oc-overrides-style>${overriddenIdsCss}{visibility:hidden!important;pointer-events:none!important}</style>`
    : "";

  const baselineBlock = `<style data-oc-baseline-style>[data-oc-layer-id]{box-sizing:border-box}</style>`;

  // Wrap the original content in a relative container so absolute layers
  // measure off the slide root, not the page.
  return (
    baselineBlock +
    hideOriginalsBlock +
    `<div data-oc-original-layout style="position:relative;width:100%;height:100%">${mergedSlideHtml}</div>` +
    layerHtmlParts.join("")
  );
}
