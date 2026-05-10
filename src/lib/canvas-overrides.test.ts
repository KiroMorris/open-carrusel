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

import { applyOverrides, hashLayerId } from "./canvas-overrides.ts";
import { wrapSlideHtml } from "./slide-html.ts";
import type { CanvasOverrides } from "../types/carousel";

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
