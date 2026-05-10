/**
 * geometryHelpers — shared math for image-frame and shape geometry.
 *
 * Phase 2 (canvas-image-frames) extracted these helpers so the editor runtime
 * (`editor-runtime.ts`, runs INSIDE the iframe) and the export-mode splice
 * (`canvas-overrides.ts`, runs in Node + browser) cannot diverge over time.
 *
 * Both call sites compute:
 *   - cover-fit calibration for an image inside a frame
 *   - clamp tx/ty so the image always covers the frame (no letterboxing)
 *   - frame translate delta from the captured natural position
 *
 * IMPORTANT: this module has zero DOM and zero React dependencies. The editor
 * runtime CANNOT actually `import` this file (no bundler inside the iframe);
 * instead, the bundle script INLINES the helper bodies into the runtime via
 * the `// --- BEGIN geometryHelpers --- // --- END geometryHelpers ---`
 * markers. The editor runtime's TS source then re-uses the same identifiers,
 * keeping byte-stable parity with this module.
 *
 * If you change a helper here, run `npm run build:editor-runtime` so the
 * inlined copy refreshes.
 */

// --- BEGIN geometryHelpers ---

export interface FrameRect {
  w: number;
  h: number;
}

export interface NaturalDims {
  w: number;
  h: number;
}

export interface ImageInner {
  scale: number;
  tx: number;
  ty: number;
}

export interface NaturalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameXform {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

/**
 * Cover-fit calibration: scale + translate that makes `natural` fully cover
 * `frame`, centered. Equivalent to `object-fit:cover; object-position:center`.
 *
 * Edge cases:
 *   - natural.w or natural.h <= 0 → returns identity {scale:1, tx:0, ty:0}
 *     (caller should defer registration until the image's naturalWidth is
 *     non-zero; this is the safe fallback).
 *   - frame smaller than natural → coverScale < 1, image shrinks.
 *   - frame larger than natural → coverScale > 1, image upscales.
 */
export function coverFitCalibration(
  natural: NaturalDims,
  frame: FrameRect
): ImageInner {
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

/**
 * Re-clamp `image` so it still covers `frame` after a frame resize OR an
 * inside-frame pan/zoom. Mutates a copy; returns the new ImageInner.
 *
 * Invariant maintained: scale >= minScale (frame is fully covered) AND
 * tx/ty in [frame.w - renderedW, 0] / [frame.h - renderedH, 0].
 *
 * The MAX scale clamp is a hard 8x to prevent runaway zoom (matches plan §9).
 */
export function reclampImageToCover(
  image: ImageInner,
  frame: FrameRect,
  natural: NaturalDims
): ImageInner {
  if (natural.w <= 0 || natural.h <= 0) return image;
  const minScale = Math.max(frame.w / natural.w, frame.h / natural.h);
  let scale = image.scale;
  if (scale < minScale) scale = minScale;
  if (scale > 8) scale = 8;
  const renderedW = natural.w * scale;
  const renderedH = natural.h * scale;
  // tx in [frame.w - renderedW, 0]; tx <= 0; right edge of image >= frame.w.
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

/**
 * Compose the CSS `transform` string for the FRAME element based on the
 * override's frame transform AND the natural rect captured at registration.
 *
 * Semantics: keep the element in normal flow; movement is the delta from
 * its natural in-flow position. Rotation is folded in.
 *
 * Returns "" when no transform is needed (matches authored-flow zero state).
 */
export function frameTransformString(
  frame: FrameXform,
  naturalRect: NaturalRect
): string {
  const dx = frame.x - naturalRect.x;
  const dy = frame.y - naturalRect.y;
  const transforms: string[] = [];
  if (dx !== 0 || dy !== 0) transforms.push("translate(" + dx + "px," + dy + "px)");
  if (frame.rotation !== 0) transforms.push("rotate(" + frame.rotation + "deg)");
  return transforms.join(" ");
}

/**
 * Compose the CSS `transform` string for the INNER `<img>` (wrapped/parent).
 * For "background" source the same scale/tx/ty values are mapped to
 * background-size/background-position by the caller — see backgroundSizeFor /
 * backgroundPositionFor below.
 */
export function innerImageTransformString(image: ImageInner): string {
  return (
    "translate(" + image.tx + "px," + image.ty + "px) scale(" + image.scale + ")"
  );
}

/** background-size for "background" source — `{renderedW}px {renderedH}px`. */
export function backgroundSizeFor(natural: NaturalDims, image: ImageInner): string {
  return natural.w * image.scale + "px " + natural.h * image.scale + "px";
}

/** background-position for "background" source — `{tx}px {ty}px`. */
export function backgroundPositionFor(image: ImageInner): string {
  return image.tx + "px " + image.ty + "px";
}

/**
 * Phase 4 — cursor-anchored zoom.
 *
 * Given the previous image transform, a cursor position in FRAME-LOCAL
 * coords, and a multiplicative zoom `factor`, compute the new transform
 * such that the source-image pixel under the cursor stays anchored under
 * the cursor after the zoom.
 *
 * Algorithm:
 *   1. Compute the desired new scale, clamped to [minScale, 8] where
 *      `minScale = max(frame.w/natural.w, frame.h/natural.h)` (the cover
 *      invariant — image must always fully cover the frame).
 *   2. Project the cursor onto image-space at the OLD scale:
 *        cursorImgX = (cursor.x - prev.tx) / prev.scale
 *      That's the pixel of the source image under the cursor.
 *   3. Solve for new tx, ty so that point lands under the cursor again
 *      at the NEW scale:
 *        tx = cursor.x - cursorImgX * newScale
 *   4. Re-clamp tx, ty so the image still covers the frame on both axes.
 *
 * Edge cases:
 *   - prev.scale === 0 (degenerate, shouldn't happen): treated as no-op
 *     (returns prev unchanged) to avoid division-by-zero NaN poisoning.
 *   - factor that would push us below minScale or above 8 is silently
 *     clamped — the cursor anchor still resolves around the clamped
 *     scale, which matches user expectation (zoom "stops" smoothly at
 *     the limits instead of flying off-anchor).
 *   - natural.w/h <= 0 returns prev (image not loaded yet).
 */
export function cursorAnchoredZoom(
  prev: ImageInner,
  cursor: { x: number; y: number },
  factor: number,
  natural: NaturalDims,
  frame: FrameRect
): ImageInner {
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
  // Re-clamp to keep cover invariant.
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

/**
 * Phase 5 — extract a single `url(...)` value from a computed
 * `background-image` string.
 *
 * Returns the URL when the computed value is a single `url(...)` (or the
 * FIRST `url(...)` when comma-separated multiple values are present and at
 * least one of them is a `url()`); returns `null` for:
 *   - `"none"`, empty, or unparsable input
 *   - any value whose ONLY layers are gradients (no `url()` present)
 *   - SVG data-URIs (`data:image/svg…`) — too varied to reliably preload
 *
 * Tolerates:
 *   - quoted (`url("…")`, `url('…')`) and unquoted (`url(…)`) variants
 *   - leading/trailing CSS shorthand junk like
 *     `url(/x.png) center / cover no-repeat` (we still extract the URL)
 *   - multiple comma-separated layers like
 *     `url(/x.png), linear-gradient(...)` — first url() wins
 *
 * Whitespace inside the `url(...)` parens is trimmed.
 *
 * Mirrored verbatim into `editor-runtime.ts`. Tests in
 * `geometryHelpers.test.ts` lock down each edge case so the runtime copy
 * cannot drift.
 */
export function extractBgUrl(bg: string | null | undefined): string | null {
  if (!bg) return null;
  const s = String(bg).trim();
  if (!s || s === "none") return null;
  // Walk the string and find the FIRST `url(...)` occurrence. The url body
  // is anything up to the matching closing paren; we tolerate optional
  // surrounding single/double quotes and inner whitespace.
  const re = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const url = m[2].trim();
    if (!url) continue;
    if (url.indexOf("data:image/svg") === 0) {
      // SVG data-URI — skip THIS layer; another url() further along may be
      // a real raster image, so we keep scanning.
      continue;
    }
    return url;
  }
  return null;
}

// --- END geometryHelpers ---
