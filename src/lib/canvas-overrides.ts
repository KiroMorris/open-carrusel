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
 * Phase 1 scope: enough rendering machinery for export to round-trip
 * overrides; the editor runtime that produces them ships in Phase 2.
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
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Derive a stable layer id from (tag, css-path, normalized-text).
 *
 * - `tag`: lowercase HTML tag name (e.g. `"h1"`, `"div"`).
 * - `cssPath`: a structural path like `"div>div>h1:nth-child(2)"`. The exact
 *   format is up to the caller; what matters is that the editor runtime and
 *   `applyOverrides()` produce the same string for the same node.
 * - `normalizedText`: the layer's text content, normalized (or `""` if the
 *   caller hasn't normalized — we re-normalize defensively).
 */
export function hashLayerId(
  tag: string,
  cssPath: string,
  normalizedText: string
): string {
  const t = (tag ?? "").toLowerCase();
  const p = cssPath ?? "";
  const x = normalizeText(normalizedText ?? "");
  return "oc-" + hash53(`${t}|${p}|${x}`);
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

// --- Public API --------------------------------------------------------------

/**
 * Apply overrides to slide body HTML. Pure function; safe in Node + browser.
 *
 * Strategy (per plan §6 "Edge case"):
 *   1. Wrap the original body content in `<div data-oc-original-layout>` so
 *      siblings of overridden layers stay where Claude placed them.
 *   2. For overridden EXISTING layers, we cannot reliably find them in raw
 *      string HTML without a DOM parser, so we emit absolute-positioned
 *      replicas appended after the original layout. Phase 2 (editor runtime)
 *      handles the in-place hide-the-original-element step. For Phase 1, the
 *      replica is sufficient because export-time DOM is always rebuilt by
 *      Puppeteer; we sidestep the "find the original DOM node" problem by
 *      letting the editor runtime do the marking on the live DOM.
 *      ↳ A `<style>` tag at the top of body hides any elements that already
 *        carry a matching `data-oc-layer-id` attribute, so if a future
 *        runtime annotates the source HTML the originals visibly disappear.
 *   3. For NEW layers, append a fresh `<div data-oc-layer-id>` to the body.
 *
 * Returns the original `slideHtml` unchanged if `overrides` is null/empty.
 */
export function applyOverrides(
  slideHtml: string,
  overrides: CanvasOverrides | null | undefined
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

  // z-index is derived from `order` so the order array is the source of
  // truth even if individual layers carry stale `transform.z`.
  const orderArr = Array.isArray(overrides.order) ? overrides.order : [];
  const zForId = new Map<string, number>();
  orderArr.forEach((id, idx) => {
    // base z=10 so we sit above Claude's typical layout but below absurd
    // z-index:9999 cases. A layer not in `order` falls through to its own z.
    zForId.set(id, 10 + idx);
  });

  // Build the layer markup
  const layerHtmlParts: string[] = [];
  for (const id of layerIds) {
    const layer = layersObj[id];
    if (!layer || !layer.transform || !layer.style) continue;
    const z = zForId.get(id) ?? layer.transform.z ?? 10;
    const styleAttr = transformToCss(layer, z);
    const text = layer.text != null ? escapeHtml(layer.text) : "";
    // For existing layers, the text is optional (override may only have
    // touched style/transform). For new layers, we always render the text.
    const inner = layer.text != null ? text : "";
    layerHtmlParts.push(
      `<div data-oc-layer-id="${escapeAttr(id)}" data-oc-layer-kind="${layer.kind}" style="${styleAttr}">${inner}</div>`
    );
  }

  // The hide-original block: any element pre-tagged with a matching
  // data-oc-layer-id (by the editor runtime) becomes visibility:hidden so
  // the original layout slot is preserved but the visible glyphs come from
  // our absolute replica.
  const overriddenIdsCss = layerIds
    .filter((id) => layersObj[id]?.kind === "existing")
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
    `<div data-oc-original-layout style="position:relative;width:100%;height:100%">${slideHtml}</div>` +
    layerHtmlParts.join("")
  );
}
