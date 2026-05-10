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

import type {
  CanvasLayer,
  CanvasOverrides,
  ImageOverride,
  LayerStyle,
  ShapeOverride,
} from "@/types/carousel";

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

// --- Shape & image overrides (export-mode only) -----------------------------

/**
 * Build a `(tag, cssPath) → ScannedElement` index for the supplied html. The
 * index is keyed the same way `hashLayerId()` keys overrides — first-seen-
 * wins on the rare case two scanned elements collide (the same hash).
 */
function indexScannedById(html: string): Map<string, ScannedElement> {
  const out = new Map<string, ScannedElement>();
  let scanned: ScannedElement[] = [];
  try {
    scanned = scanSlideHtml(html);
  } catch {
    return out;
  }
  for (const el of scanned) {
    const id = hashLayerId(el.tag, el.cssPath);
    if (!out.has(id)) out.set(id, el);
  }
  return out;
}

/**
 * Build a z-index lookup from the unified `order` array. Same base (10) as
 * the text-layer pass so the three kinds interleave correctly.
 */
function buildZIndex(order: string[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!Array.isArray(order)) return map;
  order.forEach((id, idx) => map.set(id, 10 + idx));
  return map;
}

/**
 * Splice an additional `style="..."` declaration onto the start tag of a
 * scanned element. Preserves any existing `style` attribute (we APPEND with
 * a leading `;` so later declarations win, matching CSS cascade rules).
 *
 * Returns the new html. The caller is responsible for descending-byte-offset
 * ordering when applying multiple splices to the same html.
 */
function injectInlineStyle(
  html: string,
  el: ScannedElement,
  styleDecls: string
): string {
  if (!styleDecls) return html;
  const startTagSlice = html.slice(el.startOpen, el.startClose);
  // Look for an existing style="..." attribute. We tolerate single OR double
  // quotes and arbitrary whitespace between `=` and the quote.
  const styleAttrRe = /(\sstyle\s*=\s*)(["'])([^"']*)\2/i;
  const match = styleAttrRe.exec(startTagSlice);
  if (match) {
    // Append to existing style. Index of the closing quote within startTagSlice:
    const closeQuoteIdx =
      match.index + match[1].length + 1 + match[3].length; // pos of `"`
    const absoluteCloseQuoteIdx = el.startOpen + closeQuoteIdx;
    const sep =
      match[3].length > 0 && !match[3].trimEnd().endsWith(";") ? ";" : "";
    return (
      html.slice(0, absoluteCloseQuoteIdx) +
      sep +
      styleDecls +
      html.slice(absoluteCloseQuoteIdx)
    );
  }
  // No existing style attr — insert one just before the closing `>` (or `/>`).
  let insertAt = el.startClose - 1; // pos of `>`
  while (
    insertAt > el.startOpen &&
    (html[insertAt - 1] === "/" ||
      html[insertAt - 1] === " " ||
      html[insertAt - 1] === "\t" ||
      html[insertAt - 1] === "\n")
  ) {
    insertAt--;
  }
  const injected = ` style="${styleDecls}"`;
  return html.slice(0, insertAt) + injected + html.slice(insertAt);
}

/**
 * Compose the CSS declarations a frame transform should add inline. We
 * always emit width/height/transform; rotation is folded into transform.
 *
 * The `naturalRect` is the position the element occupied BEFORE the
 * override was created (computed at runtime registration time, persisted in
 * the override). Translate is the delta between the override's frame
 * position and that natural position so the existing layout context stays
 * intact and we just nudge the element by the user's edit.
 */
function frameTransformDecls(
  frame: { x: number; y: number; w: number; h: number; rotation: number; z: number },
  natural: { x: number; y: number; w: number; h: number },
  zIndex: number
): string {
  const dx = frame.x - natural.x;
  const dy = frame.y - natural.y;
  const transforms: string[] = [];
  if (dx !== 0 || dy !== 0) transforms.push(`translate(${dx}px,${dy}px)`);
  if (frame.rotation !== 0) transforms.push(`rotate(${frame.rotation}deg)`);
  const parts: string[] = [];
  if (transforms.length > 0) parts.push(`transform:${transforms.join(" ")}`);
  parts.push(`width:${frame.w}px`);
  parts.push(`height:${frame.h}px`);
  parts.push(`z-index:${zIndex}`);
  return parts.join(";");
}

/**
 * Splice shape overrides into the supplied html. For each shape we look up
 * the matched element by `(tag, cssPath)` hash and inject inline
 * `transform`/`width`/`height` onto its start tag.
 *
 * Splices run in descending byte-offset order so each mutation does not
 * invalidate earlier offsets. Shapes that don't match any scanned element
 * are silently dropped (the runtime registration is the source of truth;
 * a missing match indicates the slide HTML changed out-of-band and we
 * cannot recover).
 */
export function applyShapeOverrides(
  slideHtml: string,
  shapes: Record<string, ShapeOverride>,
  order?: string[]
): string {
  const ids = Object.keys(shapes ?? {});
  if (ids.length === 0) return slideHtml;
  const idx = indexScannedById(slideHtml);
  const z = buildZIndex(order);
  type Splice = { el: ScannedElement; decls: string };
  const splices: Splice[] = [];
  for (const id of ids) {
    const shape = shapes[id];
    if (!shape || !shape.frame || !shape.naturalRect) continue;
    const el = idx.get(id);
    if (!el) continue;
    const zIndex = z.get(id) ?? shape.frame.z ?? 10;
    const decls = frameTransformDecls(shape.frame, shape.naturalRect, zIndex);
    splices.push({ el, decls });
  }
  // Splice in descending byte-offset order.
  splices.sort((a, b) => b.el.startClose - a.el.startClose);
  let out = slideHtml;
  for (const { el, decls } of splices) {
    out = injectInlineStyle(out, el, decls);
  }
  return out;
}

/**
 * Splice image overrides into the supplied html. Per `source`:
 *
 *   "wrapped":   DELETE the original `<img>` tag and INSERT a wrapper
 *                `<div data-oc-image-frame="{id}" style="...frame...">
 *                  <img src="..." style="...inner...">
 *                </div>` in its place. The original `<img>`'s class list is
 *                dropped (a baseline `<style>` block resets `<img>` rules
 *                inside the wrapper) so author CSS like `.bg img { width:100% }`
 *                cannot fight the inner transform.
 *   "parent":    Inject `overflow:hidden`, frame transform, and width/height
 *                onto the parent of the matched `<img>`. ALSO inject the inner
 *                image transform onto the `<img>` itself.
 *   "background": Inject `background-size`, `background-position`,
 *                `background-repeat:no-repeat`, plus the frame transform onto
 *                the matched element. There is no inner `<img>`.
 *
 * Splices run in descending byte-offset order so each mutation does not
 * invalidate earlier offsets.
 */
export function applyImageOverrides(
  slideHtml: string,
  images: Record<string, ImageOverride>,
  order?: string[]
): string {
  const ids = Object.keys(images ?? {});
  if (ids.length === 0) return slideHtml;
  const idx = indexScannedById(slideHtml);
  const z = buildZIndex(order);

  type Op =
    | { kind: "replace"; from: number; to: number; html: string }
    | { kind: "style-inject"; el: ScannedElement; decls: string }
    | { kind: "img-replace-attrs"; el: ScannedElement; transformDecl: string };

  const ops: Op[] = [];

  for (const id of ids) {
    const img = images[id];
    if (!img || !img.frame || !img.image || !img.natural) continue;
    const el = idx.get(id);
    if (!el) continue;
    const zIndex = z.get(id) ?? img.frame.z ?? 10;
    const i = img.image;
    const innerTransform = `transform:translate(${i.tx}px,${i.ty}px) scale(${i.scale});transform-origin:0 0`;

    if (img.source === "wrapped") {
      // Recover original src/alt from the start tag slice. The original
      // `<img>` is a void element so endOpen/endClose are -1; we replace
      // the entire start tag with the wrapper.
      const startTag = slideHtml.slice(el.startOpen, el.startClose);
      const srcMatch = /\ssrc\s*=\s*(["'])([^"']*)\1/i.exec(startTag);
      const altMatch = /\salt\s*=\s*(["'])([^"']*)\1/i.exec(startTag);
      const src = srcMatch ? srcMatch[2] : "";
      const alt = altMatch ? altMatch[2] : "";
      const f = img.frame;
      const dx = f.x - (img.naturalFrameRect?.x ?? 0);
      const dy = f.y - (img.naturalFrameRect?.y ?? 0);
      const transforms: string[] = [];
      if (dx !== 0 || dy !== 0) transforms.push(`translate(${dx}px,${dy}px)`);
      if (f.rotation !== 0) transforms.push(`rotate(${f.rotation}deg)`);
      const wrapperStyle =
        (transforms.length ? `transform:${transforms.join(" ")};` : "") +
        `width:${f.w}px;height:${f.h}px;` +
        `overflow:hidden;z-index:${zIndex};` +
        `position:relative`;
      const innerStyle =
        `position:absolute;top:0;left:0;width:auto;height:auto;` +
        `max-width:none;max-height:none;${innerTransform}`;
      const replacement =
        `<div data-oc-image-frame="${escapeAttr(id)}" style="${wrapperStyle}">` +
        `<img src="${escapeAttr(src)}"${alt ? ` alt="${escapeAttr(alt)}"` : ""} style="${innerStyle}">` +
        `</div>`;
      ops.push({
        kind: "replace",
        from: el.startOpen,
        to: el.startClose,
        html: replacement,
      });
    } else if (img.source === "parent") {
      // Mutate the parent's inline style with frame transform + overflow,
      // then add inner-image transform to the <img> itself. The parent is
      // the scanned element whose cssPath is the prefix of `el.cssPath`.
      const parentPath = el.cssPath.includes(">")
        ? el.cssPath.slice(0, el.cssPath.lastIndexOf(">"))
        : "";
      // Find the parent in the scan by cssPath equality (not by hash —
      // the parent has a different (tag, cssPath) than the <img>).
      let parentEl: ScannedElement | undefined;
      // We need to scan again or look up by path. Since indexScannedById is
      // hashed-by-id, we re-scan to find the parent. Cheap because this only
      // runs in export mode.
      const allScanned = (() => {
        try {
          return scanSlideHtml(slideHtml);
        } catch {
          return [];
        }
      })();
      parentEl = allScanned.find(
        (s) => s.cssPath === parentPath
      );
      if (parentEl) {
        const f = img.frame;
        const dx = f.x - (img.naturalFrameRect?.x ?? 0);
        const dy = f.y - (img.naturalFrameRect?.y ?? 0);
        const transforms: string[] = [];
        if (dx !== 0 || dy !== 0) transforms.push(`translate(${dx}px,${dy}px)`);
        if (f.rotation !== 0) transforms.push(`rotate(${f.rotation}deg)`);
        const parentDecls =
          (transforms.length ? `transform:${transforms.join(" ")};` : "") +
          `width:${f.w}px;height:${f.h}px;overflow:hidden;z-index:${zIndex}`;
        ops.push({ kind: "style-inject", el: parentEl, decls: parentDecls });
      }
      // Always update the <img> inner transform.
      ops.push({ kind: "style-inject", el, decls: innerTransform });
    } else if (img.source === "background") {
      const f = img.frame;
      const renderedW = img.natural.w * i.scale;
      const renderedH = img.natural.h * i.scale;
      const dx = f.x - (img.naturalFrameRect?.x ?? 0);
      const dy = f.y - (img.naturalFrameRect?.y ?? 0);
      const transforms: string[] = [];
      if (dx !== 0 || dy !== 0) transforms.push(`translate(${dx}px,${dy}px)`);
      if (f.rotation !== 0) transforms.push(`rotate(${f.rotation}deg)`);
      const decls =
        (transforms.length ? `transform:${transforms.join(" ")};` : "") +
        `width:${f.w}px;height:${f.h}px;` +
        `background-size:${renderedW}px ${renderedH}px;` +
        `background-position:${i.tx}px ${i.ty}px;` +
        `background-repeat:no-repeat;` +
        `overflow:hidden;z-index:${zIndex}`;
      ops.push({ kind: "style-inject", el, decls });
    }
  }

  // Apply ops in descending byte-offset order so earlier offsets stay valid.
  // For style-injects + img-replace-attrs we use el.startClose; for replaces
  // we use the `from` offset directly.
  const offsetOf = (op: Op): number => {
    if (op.kind === "replace") return op.from;
    if (op.kind === "style-inject") return op.el.startClose;
    return op.el.startClose;
  };
  ops.sort((a, b) => offsetOf(b) - offsetOf(a));

  let out = slideHtml;
  for (const op of ops) {
    if (op.kind === "replace") {
      out = out.slice(0, op.from) + op.html + out.slice(op.to);
    } else if (op.kind === "style-inject") {
      out = injectInlineStyle(out, op.el, op.decls);
    }
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
 *     - For EXISTING text layers WITH a text override: emit a replica that
 *       replaces the original glyphs, plus a visibility:hidden rule keyed on
 *       the original's runtime-tagged `data-oc-layer-id` attribute.
 *     - For EXISTING layers WITHOUT a text override: skip — the runtime
 *       mutates the original element in place at load time.
 *     - Image and shape overrides are NOT spliced into the HTML in preview
 *       mode — the runtime applies them via inline style at runtime
 *       (Phase 2 owns the runtime; Phase 1 just guarantees the storage
 *       round-trips and export is correct).
 *
 *   EXPORT (used by `exportSlide` and `exportSlideVideo`):
 *     - Same NEW-layer behavior.
 *     - For EXISTING text layers (with OR without text override): scan the
 *       source HTML for the matching element, recover its inner text, and
 *       emit a replica carrying the merged transform/style + recovered text.
 *       Always hide the original.
 *     - For shape overrides: splice inline `transform: translate(...) rotate(...)`
 *       and `width`/`height` onto the matched element by `(tag, cssPath)` hash.
 *     - For image overrides: emit a wrapper-div + inner `<img>` (`source: "wrapped"`),
 *       OR mutate the parent's inline style + the `<img>` inline transform
 *       (`source: "parent"`), OR mutate the matched div's
 *       `background-size`/`-position`/`-repeat` (`source: "background"`).
 *
 * Pass order is: shapes → images → text replicas. Shapes come first because
 * they only mutate inline `style` attributes (low-disruption), images
 * second because the `wrapped` source DELETES the original `<img>` and
 * INSERTS a `<div>` wrapper (high-disruption). Text replicas always run last
 * against whatever the previous two passes left behind — it scans the post-
 * shape/image HTML to find original elements by (tag, cssPath) hash, which
 * stays stable because shapes don't change tag names and image `wrapped`
 * splices add a new ancestor that we don't traverse for text.
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
  // than a non-null object for each map as "empty".
  const layersObj =
    overrides.layers && typeof overrides.layers === "object"
      ? overrides.layers
      : {};
  const imagesObj =
    overrides.images && typeof overrides.images === "object"
      ? overrides.images
      : {};
  const shapesObj =
    overrides.shapes && typeof overrides.shapes === "object"
      ? overrides.shapes
      : {};
  const layerIds = Object.keys(layersObj);
  const imageIds = Object.keys(imagesObj);
  const shapeIds = Object.keys(shapesObj);

  const mode = options?.mode ?? "preview";

  // Hash-collision invariant: the (tag, cssPath) hash space is shared across
  // text/image/shape maps. The runtime registers each element under exactly
  // one map, but a misbehaving client could theoretically insert the same id
  // into two maps. Surface the conflict early so debugging is fast.
  const seen = new Set<string>();
  const collide = (id: string, kind: string) => {
    if (seen.has(id)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[canvas-overrides] hash collision: id="${id}" appears in multiple override maps (last seen as ${kind}). Last-write-wins; check the runtime registration order.`
      );
    }
    seen.add(id);
  };
  for (const id of layerIds) collide(id, "text");
  for (const id of imageIds) collide(id, "image-frame");
  for (const id of shapeIds) collide(id, "shape");

  // Apply shape and image overrides first (export-only; preview leaves them
  // for the runtime). The output of each pass becomes the input of the next.
  let workingHtml = slideHtml;
  if (mode === "export") {
    workingHtml = applyShapeOverrides(workingHtml, shapesObj, overrides.order);
    workingHtml = applyImageOverrides(workingHtml, imagesObj, overrides.order);
  }

  // After shapes/images we still need the text path. If there are no text
  // layers we can short-circuit AND skip the wrapper, but only if we also
  // produced no shape/image splices. When shapes/images mutated the html
  // (mode === "export"), workingHtml differs from slideHtml and we must
  // return that mutated string even with zero text layers.
  if (layerIds.length === 0) {
    return workingHtml;
  }

  // Re-bind slideHtml for the text path so all the existing offset-based
  // logic operates on the post-shape-image string.
  slideHtml = workingHtml;

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
