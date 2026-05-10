/**
 * Tests for geometryHelpers.ts — the shared math used by BOTH the export
 * splice (`canvas-overrides.ts`) and the editor runtime (`editor-runtime.ts`).
 *
 * The runtime cannot import the helpers (no bundler in the iframe); it
 * inlines the same identifiers and bodies. These tests lock down the math
 * so a divergence between the two copies surfaces immediately.
 *
 * Run: node --test --experimental-strip-types --import ./scripts/test-loader.mjs src/lib/geometryHelpers.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coverFitCalibration,
  reclampImageToCover,
  frameTransformString,
  innerImageTransformString,
  backgroundSizeFor,
  backgroundPositionFor,
  cursorAnchoredZoom,
  extractBgUrl,
} from "./geometryHelpers.ts";

test("coverFitCalibration: square image into wider frame upscales by frame.w", () => {
  const c = coverFitCalibration({ w: 100, h: 100 }, { w: 200, h: 100 });
  assert.equal(c.scale, 2);
  // Rendered = 200x200; centered horizontally tx=0; centered vertically ty=(100-200)/2 = -50
  assert.equal(c.tx, 0);
  assert.equal(c.ty, -50);
});

test("coverFitCalibration: tall image into square frame upscales by frame.h", () => {
  const c = coverFitCalibration({ w: 100, h: 200 }, { w: 100, h: 100 });
  assert.equal(c.scale, 1); // max(1, 0.5) = 1
  assert.equal(c.tx, 0);
  // Rendered = 100x200; ty = (100 - 200)/2 = -50
  assert.equal(c.ty, -50);
});

test("coverFitCalibration: same-aspect frame produces zero tx, ty", () => {
  const c = coverFitCalibration({ w: 200, h: 100 }, { w: 400, h: 200 });
  assert.equal(c.scale, 2);
  assert.equal(c.tx, 0);
  assert.equal(c.ty, 0);
});

test("coverFitCalibration: zero-natural input returns identity", () => {
  const c = coverFitCalibration({ w: 0, h: 0 }, { w: 100, h: 100 });
  assert.deepEqual(c, { scale: 1, tx: 0, ty: 0 });
});

test("reclampImageToCover: tx > 0 is clamped to 0", () => {
  const out = reclampImageToCover(
    { scale: 2, tx: 50, ty: 0 },
    { w: 100, h: 100 },
    { w: 100, h: 100 }
  );
  assert.equal(out.tx, 0);
});

test("reclampImageToCover: scale below cover-min is bumped up", () => {
  // Frame 200x100, natural 100x100 — minScale = max(2, 1) = 2.
  const out = reclampImageToCover(
    { scale: 1, tx: 0, ty: 0 },
    { w: 200, h: 100 },
    { w: 100, h: 100 }
  );
  assert.equal(out.scale, 2);
});

test("reclampImageToCover: scale above 8 is capped", () => {
  const out = reclampImageToCover(
    { scale: 100, tx: 0, ty: 0 },
    { w: 100, h: 100 },
    { w: 100, h: 100 }
  );
  assert.equal(out.scale, 8);
});

test("reclampImageToCover: tx clamped to txMin = frame.w - renderedW", () => {
  // scale=4, natural=100x100 → rendered=400x400. Frame=100x100. txMin=-300.
  const out = reclampImageToCover(
    { scale: 4, tx: -1000, ty: -1000 },
    { w: 100, h: 100 },
    { w: 100, h: 100 }
  );
  assert.equal(out.tx, -300);
  assert.equal(out.ty, -300);
});

test("frameTransformString: identity natural produces empty string", () => {
  const s = frameTransformString(
    { x: 100, y: 100, w: 50, h: 50, rotation: 0 },
    { x: 100, y: 100, w: 50, h: 50 }
  );
  assert.equal(s, "");
});

test("frameTransformString: translate delta from natural", () => {
  const s = frameTransformString(
    { x: 150, y: 200, w: 50, h: 50, rotation: 0 },
    { x: 100, y: 100, w: 50, h: 50 }
  );
  assert.equal(s, "translate(50px,100px)");
});

test("frameTransformString: rotation only", () => {
  const s = frameTransformString(
    { x: 100, y: 100, w: 50, h: 50, rotation: 45 },
    { x: 100, y: 100, w: 50, h: 50 }
  );
  assert.equal(s, "rotate(45deg)");
});

test("frameTransformString: translate + rotate composes in order", () => {
  const s = frameTransformString(
    { x: 200, y: 100, w: 50, h: 50, rotation: 30 },
    { x: 100, y: 100, w: 50, h: 50 }
  );
  assert.equal(s, "translate(100px,0px) rotate(30deg)");
});

test("innerImageTransformString: simple", () => {
  const s = innerImageTransformString({ scale: 1.5, tx: -10, ty: -20 });
  assert.equal(s, "translate(-10px,-20px) scale(1.5)");
});

test("backgroundSizeFor: rendered dims", () => {
  assert.equal(
    backgroundSizeFor({ w: 100, h: 200 }, { scale: 1.5, tx: 0, ty: 0 }),
    "150px 300px"
  );
});

test("backgroundPositionFor: tx/ty", () => {
  assert.equal(
    backgroundPositionFor({ scale: 1, tx: -42, ty: -7 }),
    "-42px -7px"
  );
});

// --- Hash-collision invariant -----------------------------------------------
//
// The runtime registers each detected DOM element in EXACTLY ONE of
// imageById / shapeById / layerById. The hash is `(tag, cssPath)`, so an
// `<img>` and a `<div>` at the same DOM position must produce DIFFERENT
// hashes — even if their structural path inside body is identical.
//
// We re-import `hashLayerId` from canvas-overrides.ts to avoid re-running
// the runtime here.
import { hashLayerId } from "./canvas-overrides.ts";

test("hashLayerId: same cssPath, different tag → different ids (collision-free)", () => {
  const path = "div:nth-of-type(1)";
  const imgId = hashLayerId("img", path);
  const divId = hashLayerId("div", path);
  assert.notEqual(imgId, divId);
  assert.ok(imgId.startsWith("oc-"));
  assert.ok(divId.startsWith("oc-"));
});

test("hashLayerId: same tag, different cssPath → different ids", () => {
  const a = hashLayerId("img", "body>div:nth-of-type(1)>img:nth-of-type(1)");
  const b = hashLayerId("img", "body>div:nth-of-type(2)>img:nth-of-type(1)");
  assert.notEqual(a, b);
});

test("hashLayerId: identical inputs → identical ids (deterministic)", () => {
  const a = hashLayerId("svg", "body>section:nth-of-type(1)>svg:nth-of-type(1)");
  const b = hashLayerId("svg", "body>section:nth-of-type(1)>svg:nth-of-type(1)");
  assert.equal(a, b);
});

// --- Phase 4: cursor-anchored zoom -----------------------------------------
//
// The pixel under the cursor must stay under the cursor across a zoom.
// "Under the cursor" means: cursor.x in frame-local coords maps back to the
// same source-image pixel (cursor.x - tx) / scale before AND after the zoom.

test("cursorAnchoredZoom: zoom IN at frame center keeps center pixel anchored", () => {
  // Frame 200x200, natural 100x100; cover-fit scale=2, tx=0, ty=0
  // (rendered = 200x200, perfectly covers).
  const prev = { scale: 2, tx: 0, ty: 0 };
  const cursor = { x: 100, y: 100 };
  const out = cursorAnchoredZoom(prev, cursor, 1.5, { w: 100, h: 100 }, { w: 200, h: 200 });
  assert.equal(out.scale, 3);
  // Source-image pixel under cursor before zoom:
  //   (100 - 0) / 2 = 50
  // After zoom: tx + 50*3 should equal 100 → tx = -50.
  assert.equal(out.tx, -50);
  assert.equal(out.ty, -50);
  // Re-derive the under-cursor pixel from the new transform — must match.
  const newCursorImgX = (cursor.x - out.tx) / out.scale;
  assert.equal(newCursorImgX, 50);
});

test("cursorAnchoredZoom: zoom OUT below minScale clamps to minScale", () => {
  // Frame 200x200, natural 100x100. minScale = 2.
  const prev = { scale: 4, tx: -200, ty: -200 };
  const out = cursorAnchoredZoom(prev, { x: 100, y: 100 }, 0.1, { w: 100, h: 100 }, { w: 200, h: 200 });
  assert.equal(out.scale, 2);
});

test("cursorAnchoredZoom: zoom IN above 8x clamps to 8x", () => {
  const prev = { scale: 4, tx: 0, ty: 0 };
  const out = cursorAnchoredZoom(prev, { x: 100, y: 100 }, 10, { w: 100, h: 100 }, { w: 200, h: 200 });
  assert.equal(out.scale, 8);
});

test("cursorAnchoredZoom: cursor at corner (0,0) keeps corner pixel stationary", () => {
  // Frame 200x200, natural 100x100; cover-fit scale=2, tx=0, ty=0.
  // Cursor at (0,0) — source-image pixel under cursor = (0,0).
  // After zooming, tx should be 0 so that (0,0) source pixel stays at (0,0)
  // frame-local. But the re-clamp may pull tx back to keep cover; for a
  // zoom IN that's not a problem (rendered grows; corner can stay at 0).
  const prev = { scale: 2, tx: 0, ty: 0 };
  const out = cursorAnchoredZoom(prev, { x: 0, y: 0 }, 1.5, { w: 100, h: 100 }, { w: 200, h: 200 });
  assert.equal(out.scale, 3);
  // tx solves: 0 = 0 - 0*3 → tx = 0; cover-clamp: txMin = 200-300 = -100,
  // tx in [-100, 0]; 0 is in range so unchanged.
  assert.equal(out.tx, 0);
  assert.equal(out.ty, 0);
});

test("cursorAnchoredZoom: zero-natural returns prev unchanged", () => {
  const prev = { scale: 1, tx: 0, ty: 0 };
  const out = cursorAnchoredZoom(prev, { x: 50, y: 50 }, 2, { w: 0, h: 0 }, { w: 100, h: 100 });
  assert.deepEqual(out, prev);
});

test("cursorAnchoredZoom: re-clamps tx,ty so image still covers frame", () => {
  // Frame 200x200, natural 100x100, prev scale=4, tx=-300 (extreme corner).
  // Zoom out to scale=2 (=minScale). Rendered=200x200, txMin=0; tx must
  // clamp to 0 (only valid position).
  const prev = { scale: 4, tx: -300, ty: -300 };
  const out = cursorAnchoredZoom(prev, { x: 100, y: 100 }, 0.5, { w: 100, h: 100 }, { w: 200, h: 200 });
  assert.equal(out.scale, 2);
  assert.equal(out.tx, 0);
  assert.equal(out.ty, 0);
});

// ---------------------------------------------------------------------------
// Phase 5 — extractBgUrl edge cases
// ---------------------------------------------------------------------------
//
// The runtime mirrors this helper byte-for-byte. Each case below documents
// a real `getComputedStyle().backgroundImage` shape we have observed across
// authored carousel slides plus the synthetic shapes the spec calls out.

test("extractBgUrl: double-quoted url(...)", () => {
  assert.equal(extractBgUrl(`url("/uploads/x.png")`), "/uploads/x.png");
});

test("extractBgUrl: single-quoted url(...)", () => {
  assert.equal(extractBgUrl(`url('/uploads/x.png')`), "/uploads/x.png");
});

test("extractBgUrl: unquoted url(...)", () => {
  assert.equal(extractBgUrl(`url(/uploads/x.png)`), "/uploads/x.png");
});

test("extractBgUrl: linear-gradient ONLY → null", () => {
  assert.equal(
    extractBgUrl(`linear-gradient(180deg, #000, #fff)`),
    null
  );
});

test("extractBgUrl: SVG data-URI → null (skipped)", () => {
  const bg = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>")`;
  assert.equal(extractBgUrl(bg), null);
});

test("extractBgUrl: PNG data-URI → preserved (not SVG)", () => {
  // Only SVG data-URIs are skipped. Raster data-URIs are valid (and we
  // can preload them).
  const bg = `url("data:image/png;base64,AAA")`;
  assert.equal(extractBgUrl(bg), "data:image/png;base64,AAA");
});

test("extractBgUrl: multiple values — first url() wins (raster + gradient)", () => {
  assert.equal(
    extractBgUrl(`url(/uploads/x.png), linear-gradient(0deg, #000, #fff)`),
    "/uploads/x.png"
  );
});

test("extractBgUrl: multiple values — first url() wins (gradient first, then url)", () => {
  // Gradients before a url() in the layer list — we still find the url().
  assert.equal(
    extractBgUrl(`linear-gradient(0deg, #000, #fff), url(/uploads/x.png)`),
    "/uploads/x.png"
  );
});

test("extractBgUrl: multiple values — SVG data-URI then real url → real url wins", () => {
  // SVG-skip should NOT abort scanning; we keep looking for a usable url.
  assert.equal(
    extractBgUrl(
      `url("data:image/svg+xml;utf8,<svg/>"), url(/uploads/photo.jpg)`
    ),
    "/uploads/photo.jpg"
  );
});

test("extractBgUrl: trailing CSS shorthand keywords → URL still extracted", () => {
  // The legacy regex anchored on `$` and would refuse this. We must accept
  // it because the `background` shorthand surfaces this exact form in
  // `getComputedStyle().backgroundImage` in some browsers.
  assert.equal(
    extractBgUrl(`url(/uploads/x.png) center / cover no-repeat`),
    "/uploads/x.png"
  );
});

test("extractBgUrl: empty / 'none' / null inputs", () => {
  assert.equal(extractBgUrl(""), null);
  assert.equal(extractBgUrl("none"), null);
  assert.equal(extractBgUrl(null), null);
  assert.equal(extractBgUrl(undefined), null);
});

test("extractBgUrl: whitespace inside url(...) is trimmed", () => {
  assert.equal(extractBgUrl(`url(   /uploads/y.png   )`), "/uploads/y.png");
  assert.equal(extractBgUrl(`url(  "/uploads/z.png"  )`), "/uploads/z.png");
});

test("extractBgUrl: garbage input → null (no throw)", () => {
  assert.equal(extractBgUrl("not a url"), null);
  assert.equal(extractBgUrl("url("), null);
  assert.equal(extractBgUrl("url()"), null);
});

// ---------------------------------------------------------------------------
// Phase 5 — coverFitCalibration must MATCH `object-fit: cover; object-position: center`
// ---------------------------------------------------------------------------
//
// When a Claude-authored slide has `<img style="object-fit:cover; width:100%;
// height:100%">`, entering refine mode wraps the `<img>` and applies
// `coverFitCalibration` so the visible pixels stay identical. If they don't,
// the user sees a jarring jump on entering refine mode (covered by §7 of the
// Phase 5 plan). The math must be byte-identical to the browser's implicit
// cover algorithm:
//   coverScale = max(frameW/naturalW, frameH/naturalH)
//   renderedW  = naturalW * coverScale
//   renderedH  = naturalH * coverScale
//   tx = (frameW - renderedW) / 2     // negative when image overflows horizontally
//   ty = (frameH - renderedH) / 2     // negative when image overflows vertically
// Result: image fills frame exactly, centered. tx <= 0 and ty <= 0.

test("coverFitCalibration parity: 1080x1080 frame, 1920x1080 image (landscape into square)", () => {
  // Browser cover: scale = max(1080/1920, 1080/1080) = 1.0
  // rendered = 1920x1080; centered horizontally tx = (1080-1920)/2 = -420
  const c = coverFitCalibration({ w: 1920, h: 1080 }, { w: 1080, h: 1080 });
  assert.equal(c.scale, 1);
  assert.equal(c.tx, -420);
  assert.equal(c.ty, 0);
});

test("coverFitCalibration parity: 1080x1350 portrait frame, 1920x1080 image", () => {
  // Browser cover: scale = max(1080/1920, 1350/1080) = 1.25
  // rendered = 2400x1350; centered tx = (1080-2400)/2 = -660
  const c = coverFitCalibration({ w: 1920, h: 1080 }, { w: 1080, h: 1350 });
  assert.equal(c.scale, 1.25);
  assert.equal(c.tx, -660);
  assert.equal(c.ty, 0);
});

test("coverFitCalibration parity: square frame, square image, identical sizes", () => {
  const c = coverFitCalibration({ w: 500, h: 500 }, { w: 500, h: 500 });
  assert.equal(c.scale, 1);
  assert.equal(c.tx, 0);
  assert.equal(c.ty, 0);
});

test("coverFitCalibration parity: visual identity at every pixel (cover invariant)", () => {
  // For ANY frame/natural pair, the rendered rect must:
  //   - cover the frame on both axes (renderedW >= frameW, renderedH >= frameH)
  //   - be centered such that excess on each side is equal
  const cases = [
    { f: { w: 100, h: 200 }, n: { w: 100, h: 100 } },
    { f: { w: 1920, h: 1080 }, n: { w: 4096, h: 3072 } },
    { f: { w: 800, h: 800 }, n: { w: 600, h: 1200 } },
    { f: { w: 100, h: 100 }, n: { w: 1, h: 1 } },
    { f: { w: 1, h: 1 }, n: { w: 100, h: 100 } },
  ];
  for (const { f, n } of cases) {
    const c = coverFitCalibration(n, f);
    const rW = n.w * c.scale;
    const rH = n.h * c.scale;
    assert.ok(rW + 0.0001 >= f.w, `rendered W (${rW}) covers frame W (${f.w})`);
    assert.ok(rH + 0.0001 >= f.h, `rendered H (${rH}) covers frame H (${f.h})`);
    // Excess equally split: tx = -(rW - fW)/2 = (fW - rW)/2
    assert.equal(c.tx, (f.w - rW) / 2);
    assert.equal(c.ty, (f.h - rH) / 2);
  }
});

// ---------------------------------------------------------------------------
// Phase 5 — backgroundSizeFor / backgroundPositionFor parity with plan §9
// ---------------------------------------------------------------------------
// (Sanity tests above already cover the simple cases; these add the
// explicit "scale * naturalW / scale * naturalH" + "tx px ty px" formulas
// the plan calls out.)

test("backgroundSizeFor: scale=1.5 on 1200x800 → 1800px 1200px", () => {
  assert.equal(
    backgroundSizeFor({ w: 1200, h: 800 }, { scale: 1.5, tx: 0, ty: 0 }),
    "1800px 1200px"
  );
});

test("backgroundPositionFor: tx=-150, ty=-80 → '-150px -80px'", () => {
  assert.equal(
    backgroundPositionFor({ scale: 1.5, tx: -150, ty: -80 }),
    "-150px -80px"
  );
});
