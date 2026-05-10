/**
 * Phase 1 — Canvas overrides unit tests.
 *
 * Run: `node --test src/lib/canvas-overrides.test.ts`
 *
 * The test file uses relative imports (not `@/...` aliases) so Node's
 * built-in `--experimental-strip-types` can resolve every dep without a
 * bundler/loader. The shared `import type` statements are erased at run
 * time and never hit the loader.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyImageOverrides,
  applyOverrides,
  applyShapeOverrides,
  hashLayerId,
} from "./canvas-overrides.ts";
import { isSlideLocked, migrateOverrides } from "./carousels.ts";
import { wrapSlideHtml } from "./slide-html.ts";
import type {
  CanvasOverrides,
  ImageOverride,
  ShapeOverride,
} from "../types/carousel";

// ---------------------------------------------------------------------------
// applyOverrides()
// ---------------------------------------------------------------------------

test("applyOverrides: null overrides returns html unchanged", () => {
  const html = `<div class="slide"><h1>Hello</h1></div>`;
  assert.equal(applyOverrides(html, null), html);
  assert.equal(applyOverrides(html, undefined), html);
});

test("applyOverrides: empty layers map returns html unchanged", () => {
  const html = `<div class="slide"><h1>Hello</h1></div>`;
  const overrides: CanvasOverrides = {
    layers: {},
    order: [],
    schemaVersion: 1,
  };
  assert.equal(applyOverrides(html, overrides), html);
});

test("applyOverrides: existing-layer override emits data-oc-layer-id and inline transform (when text overridden)", () => {
  const html = `<div class="slide"><h1>Hello</h1></div>`;
  const id = hashLayerId("h1", "div>h1", "Hello");
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [id],
    layers: {
      [id]: {
        id,
        kind: "existing",
        transform: { x: 100, y: 200, w: 400, h: 80, rotation: 0, z: 0 },
        style: { fontSize: 48, color: "#ff0000" },
        // Text override is required to make us emit a replica for an
        // existing layer. Without it, the original element stays in place
        // and the runtime applies transform/style to it directly — that
        // way single-click selection in refine mode doesn't visually wipe
        // the slide by turning every layer into an empty replica.
        text: "Hello",
      },
    },
  };

  const result = applyOverrides(html, overrides);
  assert.ok(
    result.includes(`data-oc-layer-id="${id}"`),
    "expected data-oc-layer-id attr"
  );
  assert.ok(result.includes("position:absolute"), "expected absolute pos");
  assert.ok(result.includes("left:100px"), "expected left coordinate");
  assert.ok(result.includes("top:200px"), "expected top coordinate");
  assert.ok(result.includes("width:400px"), "expected width");
  assert.ok(result.includes("height:80px"), "expected height");
  assert.ok(
    result.includes("transform:rotate(0deg)"),
    "expected rotate transform"
  );
  assert.ok(result.includes("font-size:48px"), "expected font-size");
  assert.ok(result.includes("color:#ff0000"), "expected color");
  assert.ok(
    result.includes(`<div data-oc-original-layout`),
    "expected original-layout wrapper"
  );
  // original html is preserved inside the wrapper
  assert.ok(result.includes(html), "original html preserved");
});

test("applyOverrides: new layer appends a div with text and absolute positioning", () => {
  const html = `<div class="slide">base</div>`;
  const newId = "oc-new-1";
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [newId],
    layers: {
      [newId]: {
        id: newId,
        kind: "new",
        transform: { x: 50, y: 60, w: 200, h: 40, rotation: 15, z: 0 },
        style: { fontFamily: "Inter", fontSize: 24 },
        text: "I am new",
      },
    },
  };

  const result = applyOverrides(html, overrides);
  assert.ok(result.includes(`data-oc-layer-id="${newId}"`));
  assert.ok(result.includes(`data-oc-layer-kind="new"`));
  assert.ok(result.includes("I am new"));
  assert.ok(result.includes("transform:rotate(15deg)"));
  assert.ok(result.includes("font-family:Inter"));
  // The new-layer div appears AFTER the original-layout wrapper
  const wrapperIdx = result.indexOf("data-oc-original-layout");
  const newIdx = result.indexOf(`data-oc-layer-id="${newId}"`);
  assert.ok(wrapperIdx > -1 && newIdx > wrapperIdx, "new layer after wrapper");
});

test("applyOverrides: order array determines z-index ordering", () => {
  const html = `<div>x</div>`;
  const a = "oc-a";
  const b = "oc-b";
  const c = "oc-c";
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [a, b, c],
    layers: {
      [a]: {
        id: a, kind: "new", text: "A",
        transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 0 },
        style: {},
      },
      [b]: {
        id: b, kind: "new", text: "B",
        transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 0 },
        style: {},
      },
      [c]: {
        id: c, kind: "new", text: "C",
        transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 0 },
        style: {},
      },
    },
  };

  const result = applyOverrides(html, overrides);
  // Pull out the z-index value associated with each layer id by scanning
  // each layer's div block.
  const zFor = (id: string) => {
    const div = result.split(`data-oc-layer-id="${id}"`)[1];
    const m = div.match(/z-index:(\d+)/);
    return m ? parseInt(m[1], 10) : NaN;
  };
  const za = zFor(a);
  const zb = zFor(b);
  const zc = zFor(c);
  assert.ok(za < zb && zb < zc, `expected ascending z, got ${za}/${zb}/${zc}`);
});

// ---------------------------------------------------------------------------
// hashLayerId()
// ---------------------------------------------------------------------------

test("hashLayerId: same input → same id (deterministic)", () => {
  const a = hashLayerId("h1", "body>div>h1:nth-child(1)", "Hello World");
  const b = hashLayerId("h1", "body>div>h1:nth-child(1)", "Hello World");
  assert.equal(a, b);
});

test("hashLayerId: text normalization (whitespace + case) collapses to same id", () => {
  const a = hashLayerId("h1", "body>div>h1", "Hello World");
  const b = hashLayerId("h1", "body>div>h1", "  hello   world  ");
  assert.equal(a, b);
});

test("hashLayerId: different (tag, cssPath) → different ids", () => {
  const a = hashLayerId("h1", "body>h1", "Hello");
  const b = hashLayerId("h2", "body>h1", "Hello");
  const c = hashLayerId("h1", "body>h2", "Hello");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("hashLayerId: text changes do NOT change the id (otherwise inline edits would orphan overrides)", () => {
  const a = hashLayerId("h1", "body>h1", "Hello");
  const b = hashLayerId("h1", "body>h1", "Goodbye");
  assert.equal(a, b);
});

test("hashLayerId: id is non-empty and prefixed with oc-", () => {
  const id = hashLayerId("h1", "body", "x");
  assert.ok(id.startsWith("oc-"));
  assert.ok(id.length > 3);
});

// ---------------------------------------------------------------------------
// wrapSlideHtml() regression
// ---------------------------------------------------------------------------

test("wrapSlideHtml: no editorRuntime/overrides → no <script> tag", () => {
  const html = `<div>hi</div>`;
  const out = wrapSlideHtml(html, "4:5");
  assert.ok(!out.includes("<script"), "should contain no <script> tag");
});

test("wrapSlideHtml: editorRuntime:false explicit → no <script>", () => {
  const html = `<div>hi</div>`;
  const out = wrapSlideHtml(html, "1:1", { editorRuntime: false });
  assert.ok(!out.includes("<script"));
});

test("wrapSlideHtml: regression — output unchanged when overrides absent", () => {
  // Run twice through the new code path with two different fixture slides
  // and assert idempotence and absence of override markers.
  const fixtures = [
    `<div class="slide" style="background:#000;color:#fff">Hello</div>`,
    `<style>@keyframes x{from{opacity:0}to{opacity:1}}</style><div style="animation:x 1s">a</div>`,
  ];
  for (const html of fixtures) {
    const out = wrapSlideHtml(html, "4:5");
    assert.ok(!out.includes("data-oc-layer-id"), "no layer-id markers");
    assert.ok(!out.includes("data-oc-original-layout"), "no wrapper");
    assert.ok(!out.includes("<script"), "no script");
    // The original html appears verbatim somewhere in the output.
    assert.ok(out.includes(html), "original html preserved verbatim");
  }
});

test("wrapSlideHtml: with overrides → contains merged layout markers", () => {
  const html = `<div>x</div>`;
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: ["oc-1"],
    layers: {
      "oc-1": {
        id: "oc-1",
        kind: "new",
        transform: { x: 1, y: 2, w: 3, h: 4, rotation: 0, z: 0 },
        style: {},
        text: "n",
      },
    },
  };
  const out = wrapSlideHtml(html, "4:5", { overrides });
  assert.ok(out.includes("data-oc-layer-id=\"oc-1\""));
  assert.ok(out.includes("data-oc-original-layout"));
  assert.ok(!out.includes("<script"), "still no script (Phase 1 stub)");
});

// ---------------------------------------------------------------------------
// Phase 2 — editor runtime injection
// ---------------------------------------------------------------------------

test("wrapSlideHtml: editorRuntime:true → injects exactly one runtime <script>", () => {
  const out = wrapSlideHtml(`<div>x</div>`, "4:5", { editorRuntime: true });
  // Exactly one runtime script tag, marked with data-oc-editor-runtime so we
  // can locate it without false matches against any future inline scripts.
  const matches = out.match(/<script[^>]*data-oc-editor-runtime[^>]*>/g) || [];
  assert.equal(matches.length, 1, "expected one runtime script tag");
  // The runtime function is present (sanity check on bundle wiring).
  assert.ok(out.includes("hashLayerId"), "expected runtime body to be inlined");
});

test("wrapSlideHtml: editorRuntime omitted → still NO <script>", () => {
  // Critical regression: Phase 1 promised export call sites get no script.
  // Both `export-slides.ts` and `export-video.ts` rely on this default.
  const out = wrapSlideHtml(`<div>x</div>`, "4:5");
  assert.ok(!out.includes("<script"), "no script tag without editorRuntime");
});

// ---------------------------------------------------------------------------
// Phase 6 — defensive parsing
// ---------------------------------------------------------------------------

test("applyOverrides: malformed { layers: null } returns html unchanged", () => {
  const html = `<div>x</div>`;
  // @ts-expect-error intentional bad shape
  const result = applyOverrides(html, { layers: null, order: [], schemaVersion: 1 });
  assert.equal(result, html);
});

test("applyOverrides: malformed { order: undefined } still renders layers", () => {
  const html = `<div>x</div>`;
  const id = "oc-x";
  const result = applyOverrides(html, {
    schemaVersion: 1,
    // @ts-expect-error intentional bad shape
    order: undefined,
    layers: {
      [id]: {
        id, kind: "new", text: "t",
        transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 5 },
        style: {},
      },
    },
  });
  assert.ok(result.includes(`data-oc-layer-id="${id}"`));
  // No order array → fall through to per-layer transform.z (5).
  assert.ok(result.includes("z-index:5"));
});

test("applyOverrides: layer with missing transform is skipped (no crash)", () => {
  const html = `<div>x</div>`;
  const result = applyOverrides(html, {
    schemaVersion: 1,
    order: ["oc-broken"],
    // @ts-expect-error intentional bad shape
    layers: { "oc-broken": { id: "oc-broken", kind: "new" } },
  });
  // The malformed layer must not produce any layer-id markup; the original
  // html still survives (in the wrapper or alone).
  assert.ok(!result.includes(`data-oc-layer-id="oc-broken"`));
  assert.ok(result.includes(`<div>x</div>`));
});

test("wrapSlideHtml: animation @keyframes survives override application", () => {
  // Critical for hasAnimation() detection in the MP4 export pipeline.
  const html = `<style>@keyframes swipe{from{transform:translateX(0)}to{transform:translateX(20px)}}</style><div style="animation:swipe 1s infinite">→</div>`;
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [],
    layers: {},
  };
  const out = wrapSlideHtml(html, "4:5", { overrides });
  assert.ok(/@keyframes\s+swipe/.test(out), "keyframes survived");
  assert.ok(/animation:swipe/.test(out), "animation property survived");
});

// ---------------------------------------------------------------------------
// BUG-021 — applyOverrides({ mode })
// ---------------------------------------------------------------------------

// Helper: derive the same layer id the runtime would produce for the first
// `<h1>` direct child of `<body>`.
function existingLayerId(): string {
  // matches editor-runtime.ts cssPathOf: tag:nth-of-type(n) starting from
  // the element below body.
  return hashLayerId("h1", "h1:nth-of-type(1)");
}

test("applyOverrides: default mode is 'preview' (no replica for existing transform-only)", () => {
  const html = `<h1>Original Title</h1>`;
  const id = existingLayerId();
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [id],
    layers: {
      [id]: {
        id, kind: "existing",
        transform: { x: 100, y: 0, w: 400, h: 80, rotation: 0, z: 0 },
        style: {},
        // no text override
      },
    },
  };
  const result = applyOverrides(html, overrides);
  // No replica emitted (preview mode).
  assert.ok(!result.includes(`data-oc-layer-id="${id}"`), "no replica in preview");
  // Original html still inside the wrapper.
  assert.ok(result.includes(html));
});

test("applyOverrides: mode:'preview' explicit matches default", () => {
  const html = `<h1>Original Title</h1>`;
  const id = existingLayerId();
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [id],
    layers: {
      [id]: {
        id, kind: "existing",
        transform: { x: 100, y: 0, w: 400, h: 80, rotation: 0, z: 0 },
        style: {},
      },
    },
  };
  const a = applyOverrides(html, overrides);
  const b = applyOverrides(html, overrides, { mode: "preview" });
  assert.equal(a, b);
});

test("applyOverrides: mode:'export' emits replica for existing transform-only override (BUG-021)", () => {
  const html = `<h1>Original Title</h1>`;
  const id = existingLayerId();
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [id],
    layers: {
      [id]: {
        id, kind: "existing",
        transform: { x: 100, y: 200, w: 400, h: 80, rotation: 0, z: 0 },
        style: { fontSize: 48 },
      },
    },
  };
  const result = applyOverrides(html, overrides, { mode: "export" });
  // Replica emitted with merged transform.
  assert.ok(
    result.includes(`data-oc-layer-id="${id}"`),
    "expected replica with layer id"
  );
  assert.ok(result.includes("left:100px"), "x override present");
  assert.ok(result.includes("top:200px"), "y override present");
  assert.ok(result.includes("font-size:48px"), "style override present");
  // Recovered original text appears in replica.
  assert.ok(result.includes("Original Title"), "recovered original text in replica");
  // Hide-original CSS rule is emitted so the original doesn't bleed through.
  assert.ok(
    /\[data-oc-layer-id="[^"]+"\][^}]*visibility:hidden/.test(result),
    "expected hide-originals CSS rule"
  );
  // The matched original tag has been server-side tagged with the layer id
  // so the visibility:hidden rule actually targets it.
  assert.ok(
    new RegExp(`<h1[^>]*data-oc-layer-id="${id}"`).test(result),
    "original <h1> got the layer-id attribute injected"
  );
});

test("applyOverrides: mode:'export' emits replica for existing layer with text override too", () => {
  const html = `<h1>Original Title</h1>`;
  const id = existingLayerId();
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [id],
    layers: {
      [id]: {
        id, kind: "existing",
        transform: { x: 0, y: 0, w: 100, h: 50, rotation: 0, z: 0 },
        style: {},
        text: "Edited Title",
      },
    },
  };
  const result = applyOverrides(html, overrides, { mode: "export" });
  assert.ok(result.includes(`data-oc-layer-id="${id}"`));
  assert.ok(result.includes("Edited Title"), "text override wins over scanned text");
  assert.ok(!result.match(/Edited Title.*Edited Title/s), "no duplicate replica");
});

test("applyOverrides: mode:'export' new layer behavior is unchanged", () => {
  const html = `<div>x</div>`;
  const newId = "oc-new-export-1";
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [newId],
    layers: {
      [newId]: {
        id: newId, kind: "new", text: "fresh",
        transform: { x: 5, y: 6, w: 50, h: 20, rotation: 0, z: 0 },
        style: {},
      },
    },
  };
  const result = applyOverrides(html, overrides, { mode: "export" });
  assert.ok(result.includes(`data-oc-layer-id="${newId}"`));
  assert.ok(result.includes("fresh"));
  // No hide-original block for purely-new layers.
  assert.ok(!result.includes("visibility:hidden"));
});

test("applyOverrides: mode:'export' preserves @keyframes / animation declarations", () => {
  const html = `<style>@keyframes glow{0%{opacity:.5}100%{opacity:1}}</style><h1 style="animation:glow 1s infinite">Title</h1>`;
  const id = hashLayerId("h1", "h1:nth-of-type(1)");
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [id],
    layers: {
      [id]: {
        id, kind: "existing",
        transform: { x: 50, y: 60, w: 200, h: 40, rotation: 0, z: 0 },
        style: {},
      },
    },
  };
  const result = applyOverrides(html, overrides, { mode: "export" });
  assert.ok(/@keyframes\s+glow/.test(result), "keyframes survived");
  assert.ok(/animation:glow/.test(result), "animation property survived");
});

test("applyOverrides: mode:'export' tagging the original handles deletion + replica replacement", () => {
  // Same setup as the transform-only test, but verify the original element's
  // visibility is hidden (so only the replica is visible in the PNG).
  const html = `<h1>Hello</h1>`;
  const id = existingLayerId();
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [id],
    layers: {
      [id]: {
        id, kind: "existing",
        transform: { x: 999, y: 999, w: 100, h: 100, rotation: 0, z: 0 },
        style: {},
      },
    },
  };
  const result = applyOverrides(html, overrides, { mode: "export" });
  // The injected attribute on the original makes the visibility:hidden CSS
  // selector target the original, hiding it. The replica at (999,999)
  // remains visible.
  const originalIdx = result.indexOf(`<h1 data-oc-layer-id="${id}">`);
  assert.ok(originalIdx > -1, "original tagged with id");
  assert.ok(result.indexOf("visibility:hidden") < originalIdx, "hide rule before original");
});

test("applyOverrides: mode:'export' falls back to empty replica when scanner can't find element", () => {
  // Override targets a layer id that doesn't match anything in the slide html.
  const html = `<h1>Hello</h1>`;
  const ghostId = "oc-ghost-id-not-in-html";
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [ghostId],
    layers: {
      [ghostId]: {
        id: ghostId, kind: "existing",
        transform: { x: 10, y: 20, w: 30, h: 40, rotation: 0, z: 0 },
        style: {},
      },
    },
  };
  const result = applyOverrides(html, overrides, { mode: "export" });
  // Replica is still emitted (positioned correctly) — better than silent loss.
  assert.ok(result.includes(`data-oc-layer-id="${ghostId}"`));
  assert.ok(result.includes("left:10px"));
  // Original h1 untouched.
  assert.ok(result.includes("<h1>Hello</h1>"));
});

test("applyOverrides: mode:'export' nested element css-path scanner produces matching id", () => {
  // Mimics a typical Claude slide: <div class="slide"><div class="top"><h1>...</h1></div></div>
  const html = `<div class="slide"><div class="top"><h1>Nested Title</h1></div></div>`;
  const cssPath = "div:nth-of-type(1)>div:nth-of-type(1)>h1:nth-of-type(1)";
  const id = hashLayerId("h1", cssPath);
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [id],
    layers: {
      [id]: {
        id, kind: "existing",
        transform: { x: 333, y: 444, w: 200, h: 80, rotation: 0, z: 0 },
        style: {},
      },
    },
  };
  const result = applyOverrides(html, overrides, { mode: "export" });
  assert.ok(
    result.includes(`data-oc-layer-id="${id}"`),
    "replica for nested element"
  );
  assert.ok(result.includes("left:333px"));
  assert.ok(result.includes("Nested Title"), "recovered nested text");
});

test("applyOverrides: mode:'export' nth-of-type counters increment per tag (not per index)", () => {
  // Two h1 siblings — second one selected.
  const html = `<h1>First</h1><h1>Second</h1>`;
  const id = hashLayerId("h1", "h1:nth-of-type(2)");
  const overrides: CanvasOverrides = {
    schemaVersion: 1,
    order: [id],
    layers: {
      [id]: {
        id, kind: "existing",
        transform: { x: 50, y: 50, w: 100, h: 50, rotation: 0, z: 0 },
        style: {},
      },
    },
  };
  const result = applyOverrides(html, overrides, { mode: "export" });
  assert.ok(result.includes("Second"), "scanned and recovered second h1's text");
  // But the FIRST h1 must NOT be tagged with this id.
  assert.ok(
    !/<h1 data-oc-layer-id="[^"]+">First/.test(result),
    "first h1 NOT tagged"
  );
  assert.ok(
    new RegExp(`<h1 data-oc-layer-id="${id}">Second`).test(result),
    "second h1 IS tagged"
  );
});

// ---------------------------------------------------------------------------
// Phase 1 (image-frames + shapes) — back-compat
// ---------------------------------------------------------------------------

test("applyOverrides: empty images/shapes maps === current behavior (back-compat)", () => {
  const html = `<div class="slide"><h1>Hello</h1></div>`;
  const v1: CanvasOverrides = {
    layers: {},
    images: {},
    shapes: {},
    order: [],
    schemaVersion: 2,
  };
  // With empty maps the function should return slideHtml unchanged in either
  // mode — same observable behavior as the v1 short-circuit.
  assert.equal(applyOverrides(html, v1), html);
  assert.equal(applyOverrides(html, v1, { mode: "export" }), html);
});

test("applyOverrides: schemaVersion 1 input (no images/shapes) still works", () => {
  // The function tolerates legacy v1-shaped input (no images/shapes fields).
  const html = `<div>x</div>`;
  const overrides: CanvasOverrides = { layers: {}, order: [], schemaVersion: 1 };
  assert.equal(applyOverrides(html, overrides), html);
});

// ---------------------------------------------------------------------------
// Phase 1 — migrateOverrides
// ---------------------------------------------------------------------------

test("migrateOverrides: v1 → v2 adds empty images and shapes maps", () => {
  const v1 = {
    layers: { "oc-1": { id: "oc-1" } },
    order: ["oc-1"],
    schemaVersion: 1,
  };
  const v2 = migrateOverrides(v1)!;
  assert.equal(v2.schemaVersion, 2);
  assert.deepEqual(v2.images, {});
  assert.deepEqual(v2.shapes, {});
  assert.deepEqual(v2.layers, v1.layers);
  assert.deepEqual(v2.order, ["oc-1"]);
});

test("migrateOverrides: v2 input passes through unchanged (idempotent)", () => {
  const v2: CanvasOverrides = {
    layers: {},
    images: {},
    shapes: {},
    order: [],
    schemaVersion: 2,
  };
  const out = migrateOverrides(v2)!;
  assert.equal(out.schemaVersion, 2);
  assert.deepEqual(out.images, {});
  assert.deepEqual(out.shapes, {});
});

test("migrateOverrides: missing order array defaults to Object.keys(layers)", () => {
  const v1 = {
    layers: { "oc-a": {}, "oc-b": {} },
    schemaVersion: 1,
  };
  const v2 = migrateOverrides(v1)!;
  assert.equal(v2.order.length, 2);
  assert.ok(v2.order.includes("oc-a"));
  assert.ok(v2.order.includes("oc-b"));
});

test("migrateOverrides: null/undefined pass through", () => {
  assert.equal(migrateOverrides(null), null);
  assert.equal(migrateOverrides(undefined), null);
});

// ---------------------------------------------------------------------------
// Phase 1 — applyImageOverrides export-mode splice
// ---------------------------------------------------------------------------

test("applyImageOverrides: source='wrapped' replaces <img> with wrapper div", () => {
  const html = `<div class="bg"><img src="/uploads/photo.jpg" alt="hero" class="cover"></div>`;
  const id = hashLayerId("img", "div:nth-of-type(1)>img:nth-of-type(1)");
  const overrides: ImageOverride = {
    id,
    kind: "image-frame",
    frame: { x: 100, y: 50, w: 800, h: 600, rotation: 10, z: 0 },
    image: { scale: 1.5, tx: -120, ty: -80 },
    natural: { w: 1200, h: 800 },
    source: "wrapped",
    naturalFrameRect: { x: 0, y: 0, w: 1080, h: 1080 },
  };
  const result = applyImageOverrides(html, { [id]: overrides }, [id]);
  assert.ok(
    result.includes(`data-oc-image-frame="${id}"`),
    "expected wrapper div"
  );
  assert.ok(result.includes("overflow:hidden"), "wrapper has overflow:hidden");
  assert.ok(result.includes("width:800px"), "wrapper has frame width");
  assert.ok(result.includes("height:600px"), "wrapper has frame height");
  assert.ok(
    /transform:translate\(100px,50px\) rotate\(10deg\)/.test(result),
    "wrapper has translate+rotate"
  );
  assert.ok(result.includes("/uploads/photo.jpg"), "src preserved");
  assert.ok(result.includes(`alt="hero"`), "alt preserved");
  assert.ok(
    /transform:translate\(-120px,-80px\) scale\(1\.5\)/.test(result),
    "inner img has translate+scale"
  );
  // The original `<img src="/uploads/photo.jpg" ... class="cover">` is gone —
  // the inner img has no class attribute.
  assert.ok(
    !/<img[^>]*class="cover"/.test(result),
    "original class dropped from inner img"
  );
});

test("applyImageOverrides: source='parent' mutates parent's inline style + img transform", () => {
  const html = `<div class="bg" style="background:#000"><img src="/uploads/p.jpg"></div>`;
  const id = hashLayerId("img", "div:nth-of-type(1)>img:nth-of-type(1)");
  const overrides: ImageOverride = {
    id,
    kind: "image-frame",
    frame: { x: 50, y: 25, w: 400, h: 300, rotation: 0, z: 0 },
    image: { scale: 2, tx: -50, ty: -30 },
    natural: { w: 1000, h: 800 },
    source: "parent",
    naturalFrameRect: { x: 0, y: 0, w: 1080, h: 1350 },
  };
  const result = applyImageOverrides(html, { [id]: overrides }, [id]);
  // Parent .bg div got width/height/transform/overflow injected.
  assert.ok(/<div class="bg"[^>]*style="[^"]*width:400px/.test(result), "parent width injected");
  assert.ok(/<div class="bg"[^>]*style="[^"]*height:300px/.test(result), "parent height injected");
  assert.ok(/<div class="bg"[^>]*style="[^"]*overflow:hidden/.test(result), "parent overflow:hidden injected");
  assert.ok(
    /<div class="bg"[^>]*style="[^"]*transform:translate\(50px,25px\)/.test(result),
    "parent translate injected"
  );
  // <img> got the inner-image transform.
  assert.ok(
    /<img[^>]*style="[^"]*transform:translate\(-50px,-30px\) scale\(2\)/.test(result),
    "img inner transform injected"
  );
  // <img> src preserved.
  assert.ok(result.includes("/uploads/p.jpg"), "src preserved");
});

test("applyImageOverrides: source='background' mutates background-size/-position on the matched div", () => {
  const html = `<div class="bg" style="background-image:url('/uploads/bg.jpg')"></div>`;
  const id = hashLayerId("div", "div:nth-of-type(1)");
  const overrides: ImageOverride = {
    id,
    kind: "image-frame",
    frame: { x: 0, y: 0, w: 500, h: 400, rotation: 0, z: 0 },
    image: { scale: 0.5, tx: -100, ty: -50 },
    natural: { w: 2000, h: 1500 },
    source: "background",
    naturalFrameRect: { x: 0, y: 0, w: 1080, h: 1080 },
  };
  const result = applyImageOverrides(html, { [id]: overrides }, [id]);
  // 0.5 * 2000 = 1000, 0.5 * 1500 = 750
  assert.ok(
    /background-size:1000px 750px/.test(result),
    "background-size = scale * natural"
  );
  assert.ok(
    /background-position:-100px -50px/.test(result),
    "background-position = tx,ty"
  );
  assert.ok(
    /background-repeat:no-repeat/.test(result),
    "background-repeat:no-repeat injected"
  );
  assert.ok(/width:500px/.test(result), "frame width injected");
  assert.ok(/height:400px/.test(result), "frame height injected");
  // Original gradient/url preserved (we APPEND to existing style attr).
  assert.ok(
    result.includes("background-image:url('/uploads/bg.jpg')"),
    "original background-image preserved"
  );
});

// ---------------------------------------------------------------------------
// Phase 1 — applyShapeOverrides export-mode splice
// ---------------------------------------------------------------------------

test("applyShapeOverrides: simple <div class='circle'> with frame override gets inline transform/width/height", () => {
  const html = `<div class="circle" style="background:red;border-radius:50%"></div>`;
  const id = hashLayerId("div", "div:nth-of-type(1)");
  const shape: ShapeOverride = {
    id,
    kind: "shape",
    frame: { x: 200, y: 150, w: 80, h: 80, rotation: 30, z: 0 },
    source: "wrapped",
    naturalRect: { x: 100, y: 100, w: 50, h: 50 },
  };
  const result = applyShapeOverrides(html, { [id]: shape }, [id]);
  // Translate dx = 200-100 = 100; dy = 150-100 = 50.
  assert.ok(
    /transform:translate\(100px,50px\) rotate\(30deg\)/.test(result),
    "translate+rotate injected"
  );
  assert.ok(/width:80px/.test(result), "width injected");
  assert.ok(/height:80px/.test(result), "height injected");
  assert.ok(/z-index:10/.test(result), "z-index assigned from order");
  // Original style decls preserved (we appended).
  assert.ok(result.includes("background:red"), "original background preserved");
  assert.ok(result.includes("border-radius:50%"), "original border-radius preserved");
});

test("applyShapeOverrides: shape on element with no existing style attr", () => {
  const html = `<div class="x"></div>`;
  const id = hashLayerId("div", "div:nth-of-type(1)");
  const shape: ShapeOverride = {
    id,
    kind: "shape",
    frame: { x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 0 },
    source: "wrapped",
    naturalRect: { x: 0, y: 0, w: 10, h: 10 },
  };
  const result = applyShapeOverrides(html, { [id]: shape }, [id]);
  assert.ok(result.includes(`style="`), "style attribute created");
  assert.ok(result.includes("width:10px"), "width injected");
  assert.ok(result.includes("height:10px"), "height injected");
});

test("applyShapeOverrides: missing element silently dropped", () => {
  const html = `<div></div>`;
  const ghostId = "oc-ghost";
  const shape: ShapeOverride = {
    id: ghostId,
    kind: "shape",
    frame: { x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 0 },
    source: "wrapped",
    naturalRect: { x: 0, y: 0, w: 10, h: 10 },
  };
  const result = applyShapeOverrides(html, { [ghostId]: shape }, [ghostId]);
  assert.equal(result, html);
});

// ---------------------------------------------------------------------------
// Phase 1 — applyOverrides integration with shapes/images
// ---------------------------------------------------------------------------

test("applyOverrides: export mode mixes shapes + images + text correctly", () => {
  const html = `<div class="bg"><img src="/uploads/x.jpg"></div><h1>Hello</h1><div class="dot"></div>`;
  const imgId = hashLayerId("img", "div:nth-of-type(1)>img:nth-of-type(1)");
  const textId = hashLayerId("h1", "h1:nth-of-type(1)");
  const shapeId = hashLayerId("div", "div:nth-of-type(2)");
  const overrides: CanvasOverrides = {
    schemaVersion: 2,
    order: [imgId, shapeId, textId],
    layers: {
      [textId]: {
        id: textId,
        kind: "existing",
        transform: { x: 50, y: 60, w: 200, h: 40, rotation: 0, z: 0 },
        style: { fontSize: 32 },
      },
    },
    images: {
      [imgId]: {
        id: imgId,
        kind: "image-frame",
        frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0, z: 0 },
        image: { scale: 1, tx: 0, ty: 0 },
        natural: { w: 100, h: 100 },
        source: "wrapped",
        naturalFrameRect: { x: 0, y: 0, w: 100, h: 100 },
      },
    },
    shapes: {
      [shapeId]: {
        id: shapeId,
        kind: "shape",
        frame: { x: 5, y: 10, w: 20, h: 20, rotation: 45, z: 0 },
        source: "wrapped",
        naturalRect: { x: 0, y: 0, w: 10, h: 10 },
      },
    },
  };
  const result = applyOverrides(html, overrides, { mode: "export" });
  // Image was wrapped.
  assert.ok(
    result.includes(`data-oc-image-frame="${imgId}"`),
    "image wrapper present"
  );
  // Shape got inline transform.
  assert.ok(
    new RegExp(`transform:translate\\(5px,10px\\) rotate\\(45deg\\)`).test(result),
    "shape transform injected"
  );
  // Text replica emitted.
  assert.ok(
    result.includes(`data-oc-layer-id="${textId}"`),
    "text replica present"
  );
});

test("applyOverrides: hash collision between image and shape warns (last-write-wins)", () => {
  const html = `<div></div>`;
  const id = hashLayerId("div", "div:nth-of-type(1)");
  const overrides: CanvasOverrides = {
    schemaVersion: 2,
    order: [id],
    layers: {},
    images: {
      [id]: {
        id,
        kind: "image-frame",
        frame: { x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 0 },
        image: { scale: 1, tx: 0, ty: 0 },
        natural: { w: 10, h: 10 },
        source: "background",
        naturalFrameRect: { x: 0, y: 0, w: 10, h: 10 },
      },
    },
    shapes: {
      [id]: {
        id,
        kind: "shape",
        frame: { x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 0 },
        source: "wrapped",
        naturalRect: { x: 0, y: 0, w: 10, h: 10 },
      },
    },
  };
  // Capture console.warn — the function should warn about the collision but
  // not throw. Last-write-wins: both passes mutate the same element; result
  // contains evidence of both passes (style attr appended twice).
  const originalWarn = console.warn;
  let warned = false;
  console.warn = (msg: unknown) => {
    if (typeof msg === "string" && msg.includes("hash collision")) warned = true;
  };
  try {
    const result = applyOverrides(html, overrides, { mode: "export" });
    // Both ran (no throw, no silent drop).
    assert.ok(typeof result === "string");
    assert.ok(warned, "expected hash-collision warning on console");
  } finally {
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// Phase 1 — isSlideLocked
// ---------------------------------------------------------------------------

test("isSlideLocked: returns false for slide with no overrides", () => {
  assert.equal(isSlideLocked(undefined), false);
  assert.equal(isSlideLocked(null), false);
  assert.equal(isSlideLocked({ canvasOverrides: null }), false);
  assert.equal(
    isSlideLocked({
      canvasOverrides: {
        layers: {},
        images: {},
        shapes: {},
        order: [],
        schemaVersion: 2,
      },
    }),
    false
  );
});

test("isSlideLocked: text-only override → true", () => {
  assert.equal(
    isSlideLocked({
      canvasOverrides: {
        layers: { "oc-1": {} as never },
        images: {},
        shapes: {},
        order: ["oc-1"],
        schemaVersion: 2,
      },
    }),
    true
  );
});

test("isSlideLocked: image-only override → true", () => {
  assert.equal(
    isSlideLocked({
      canvasOverrides: {
        layers: {},
        images: { "oc-img": {} as never },
        shapes: {},
        order: ["oc-img"],
        schemaVersion: 2,
      },
    }),
    true
  );
});

test("isSlideLocked: shape-only override → true", () => {
  assert.equal(
    isSlideLocked({
      canvasOverrides: {
        layers: {},
        images: {},
        shapes: { "oc-shape": {} as never },
        order: ["oc-shape"],
        schemaVersion: 2,
      },
    }),
    true
  );
});

test("isSlideLocked: mixed (text + image + shape) → true", () => {
  assert.equal(
    isSlideLocked({
      canvasOverrides: {
        layers: { "oc-t": {} as never },
        images: { "oc-i": {} as never },
        shapes: { "oc-s": {} as never },
        order: ["oc-t", "oc-i", "oc-s"],
        schemaVersion: 2,
      },
    }),
    true
  );
});

// ---------------------------------------------------------------------------
// Phase 1 — preview-mode is a no-op for shapes/images
// ---------------------------------------------------------------------------

test("applyOverrides: preview mode does NOT splice image/shape mutations into html", () => {
  const html = `<div class="bg"><img src="/uploads/x.jpg"></div>`;
  const imgId = hashLayerId("img", "div:nth-of-type(1)>img:nth-of-type(1)");
  const overrides: CanvasOverrides = {
    schemaVersion: 2,
    order: [imgId],
    layers: {},
    images: {
      [imgId]: {
        id: imgId,
        kind: "image-frame",
        frame: { x: 50, y: 50, w: 100, h: 100, rotation: 0, z: 0 },
        image: { scale: 2, tx: -10, ty: -10 },
        natural: { w: 100, h: 100 },
        source: "wrapped",
        naturalFrameRect: { x: 0, y: 0, w: 100, h: 100 },
      },
    },
    shapes: {},
  };
  // Default mode is "preview" — runtime handles wrapping; html stays as-is.
  const result = applyOverrides(html, overrides);
  assert.equal(result, html, "preview mode returns html unchanged");
});

// ---------------------------------------------------------------------------
// Phase 5 — `source: "background"` export round-trip
// ---------------------------------------------------------------------------
//
// Mirrors the manual round-trip described in the Phase 5 plan section 5:
// pick a slide using `background-image`, PUT a `canvasOverrides.images`
// entry with a panned/zoomed `image: { scale: 1.5, tx: -100, ty: -50 }`,
// then export. The exported HTML must mutate `background-size`,
// `background-position`, and `background-repeat:no-repeat` on the matched
// element while preserving the original `background-image` URL.

test("Phase 5 round-trip: background source override mutates background-size/position", () => {
  const html =
    `<div class="hero" style="background-image:url('/uploads/hero.jpg');height:100%"></div>`;
  const id = hashLayerId("div", "div:nth-of-type(1)");
  const ov: ImageOverride = {
    id,
    kind: "image-frame",
    frame: { x: 0, y: 0, w: 1080, h: 1080, rotation: 0, z: 0 },
    image: { scale: 1.5, tx: -100, ty: -50 },
    natural: { w: 1200, h: 800 },
    source: "background",
    naturalFrameRect: { x: 0, y: 0, w: 1080, h: 1080 },
  };
  const overrides: CanvasOverrides = {
    schemaVersion: 2,
    order: [id],
    layers: {},
    images: { [id]: ov },
    shapes: {},
  };
  const baseline = applyOverrides(html, overrides, { mode: "export" });
  // Sanity: must include the new style decls.
  // 1.5 * 1200 = 1800; 1.5 * 800 = 1200.
  assert.ok(/background-size:1800px 1200px/.test(baseline), "background-size baked");
  assert.ok(/background-position:-100px -50px/.test(baseline), "background-position baked");
  assert.ok(/background-repeat:no-repeat/.test(baseline), "background-repeat baked");
  assert.ok(/width:1080px/.test(baseline), "frame width baked");
  assert.ok(/height:1080px/.test(baseline), "frame height baked");
  // Original src URL preserved (we APPEND to existing inline style attribute).
  assert.ok(
    baseline.includes("/uploads/hero.jpg"),
    "original background-image URL preserved"
  );

  // Compare with no-overrides baseline — must differ.
  const noOverrides = applyOverrides(html, null, { mode: "export" });
  assert.notEqual(baseline, noOverrides, "baked output must differ from no-override baseline");
});

test("Phase 5 round-trip: background source preserves border-radius via inline style append", () => {
  // Border-radius (e.g. circular avatar style) must survive the export
  // splice — `applyImageOverrides` appends to the existing style attribute
  // rather than replacing it, so any original CSS is preserved.
  const html =
    `<div class="avatar" style="background-image:url('/uploads/face.png');border-radius:50%;width:200px;height:200px"></div>`;
  const id = hashLayerId("div", "div:nth-of-type(1)");
  const ov: ImageOverride = {
    id,
    kind: "image-frame",
    frame: { x: 0, y: 0, w: 200, h: 200, rotation: 0, z: 0 },
    image: { scale: 1.0, tx: 0, ty: 0 },
    natural: { w: 200, h: 200 },
    source: "background",
    naturalFrameRect: { x: 0, y: 0, w: 200, h: 200 },
  };
  const result = applyImageOverrides(html, { [id]: ov }, [id]);
  assert.ok(result.includes("border-radius:50%"), "border-radius preserved");
  assert.ok(result.includes("/uploads/face.png"), "URL preserved");
  assert.ok(/background-size:200px 200px/.test(result), "background-size injected");
  assert.ok(/background-position:0px 0px/.test(result), "background-position injected");
});

test("Phase 5 round-trip: background source applies frame translate when frame moved", () => {
  // The user dragged the frame from (0,0) to (50,30). Export must emit
  // a `transform:translate(50px,30px)` decl alongside the bg mutations.
  const html =
    `<div class="bg" style="background-image:url('/uploads/bg.jpg')"></div>`;
  const id = hashLayerId("div", "div:nth-of-type(1)");
  const ov: ImageOverride = {
    id,
    kind: "image-frame",
    frame: { x: 50, y: 30, w: 400, h: 400, rotation: 0, z: 0 },
    image: { scale: 1, tx: 0, ty: 0 },
    natural: { w: 400, h: 400 },
    source: "background",
    naturalFrameRect: { x: 0, y: 0, w: 400, h: 400 },
  };
  const result = applyImageOverrides(html, { [id]: ov }, [id]);
  assert.ok(
    /transform:translate\(50px,30px\)/.test(result),
    "frame translate baked into transform"
  );
});

test("Phase 5: background source rotation baked into transform alongside translate", () => {
  const html =
    `<div class="bg" style="background-image:url('/uploads/bg.jpg')"></div>`;
  const id = hashLayerId("div", "div:nth-of-type(1)");
  const ov: ImageOverride = {
    id,
    kind: "image-frame",
    frame: { x: 100, y: 0, w: 400, h: 400, rotation: 15, z: 0 },
    image: { scale: 1, tx: 0, ty: 0 },
    natural: { w: 400, h: 400 },
    source: "background",
    naturalFrameRect: { x: 0, y: 0, w: 400, h: 400 },
  };
  const result = applyImageOverrides(html, { [id]: ov }, [id]);
  assert.ok(
    /transform:translate\(100px,0px\) rotate\(15deg\)/.test(result),
    "rotate composes after translate"
  );
});

test("Phase 5: background source on element with no existing inline style attr", () => {
  const html = `<div class="x"></div>`;
  const id = hashLayerId("div", "div:nth-of-type(1)");
  const ov: ImageOverride = {
    id,
    kind: "image-frame",
    frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0, z: 0 },
    image: { scale: 1, tx: 0, ty: 0 },
    natural: { w: 100, h: 100 },
    source: "background",
    naturalFrameRect: { x: 0, y: 0, w: 100, h: 100 },
  };
  const result = applyImageOverrides(html, { [id]: ov }, [id]);
  // A new style="" attribute must have been created (we have no original
  // to append to). Since the entry existed and produced declarations, the
  // splice is non-empty.
  assert.ok(result.includes(`style="`), "style attribute synthesized");
  assert.ok(/background-size:100px 100px/.test(result));
  assert.ok(/background-repeat:no-repeat/.test(result));
});
