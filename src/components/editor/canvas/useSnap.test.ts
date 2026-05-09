/**
 * Phase 4 — useSnap unit tests.
 *
 * Run: `node --test src/components/editor/canvas/useSnap.test.ts`
 *
 * Pure function, so these tests don't need a DOM or React renderer — Node's
 * built-in test runner with --experimental-strip-types is sufficient.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeSnap } from "./useSnap";

const BOUNDS = { w: 1080, h: 1080 };

test("snap to slide center (X) when dragged center is within threshold", () => {
  // Slide center is x=540. Dragged box center is at 200+100=300 if w=200,
  // so place it so its center is 538 (delta of -2 from center of slide).
  const dragged = { x: 538 - 100, y: 0, w: 200, h: 50 }; // center = 538
  const r = computeSnap({ dragged, others: [], bounds: BOUNDS });
  // Expect center to snap to 540 → x shifts +2.
  assert.equal(r.snappedX, dragged.x + 2);
  // No vertical anchor in threshold (top is 0 → snaps to bounds top with delta 0).
  // Y might snap to bounds.top (0) with delta 0 — verify guides include it.
  const verticals = r.guides.filter((g) => g.orientation === "v");
  assert.ok(verticals.length >= 1, "expected at least one vertical guide");
  assert.ok(verticals.some((g) => Math.abs(g.position - 540) < 0.5), "expected guide at slide center");
});

test("snap to sibling left edge", () => {
  const sibling = { x: 300, y: 100, w: 200, h: 80 };
  const dragged = { x: 304, y: 400, w: 200, h: 80 }; // left edge 4 px right of sibling left
  const r = computeSnap({ dragged, others: [sibling], bounds: BOUNDS });
  // Snap dragged.left → sibling.left (300). Delta = -4.
  assert.equal(r.snappedX, 300);
  const v = r.guides.filter((g) => g.orientation === "v");
  assert.ok(v.some((g) => Math.abs(g.position - 300) < 0.5), "expected vertical guide at x=300");
});

test("snap to sibling center", () => {
  const sibling = { x: 200, y: 100, w: 200, h: 80 }; // center = 300
  // Place dragged so its center is 303 (3px off → within threshold)
  const dragged = { x: 303 - 50, y: 400, w: 100, h: 80 };
  const r = computeSnap({ dragged, others: [sibling], bounds: BOUNDS });
  // After snap: dragged center == 300, x = 250.
  assert.equal(r.snappedX, 250);
  const v = r.guides.filter((g) => g.orientation === "v");
  assert.ok(v.some((g) => Math.abs(g.position - 300) < 0.5));
});

test("snap to sibling top edge (Y axis)", () => {
  const sibling = { x: 100, y: 500, w: 200, h: 80 };
  const dragged = { x: 600, y: 503, w: 100, h: 50 }; // 3px off sibling top
  const r = computeSnap({ dragged, others: [sibling], bounds: BOUNDS });
  assert.equal(r.snappedY, 500);
  const h = r.guides.filter((g) => g.orientation === "h");
  assert.ok(h.some((g) => Math.abs(g.position - 500) < 0.5));
});

test("no snap when far away", () => {
  const sibling = { x: 100, y: 100, w: 100, h: 50 };
  const dragged = { x: 800, y: 800, w: 100, h: 50 };
  const r = computeSnap({ dragged, others: [sibling], bounds: BOUNDS, threshold: 6 });
  // No anchors within 6 px of any sibling/bounds anchor, but bounds.right
  // (1080) is far, bounds.center (540) is far, etc. So everything > 6.
  // Note: dragged.right = 900 vs bounds.right 1080 → delta = 180. Far.
  // dragged.left = 800 vs bounds.center = 540 → delta = -260. Far.
  assert.equal(r.snappedX, 800);
  assert.equal(r.snappedY, 800);
  assert.equal(r.guides.length, 0);
});

test("no snap when disabled (Alt held)", () => {
  const sibling = { x: 300, y: 100, w: 200, h: 80 };
  const dragged = { x: 304, y: 100, w: 200, h: 80 }; // would normally snap
  const r = computeSnap({
    dragged,
    others: [sibling],
    bounds: BOUNDS,
    disabled: true,
  });
  assert.equal(r.snappedX, 304);
  assert.equal(r.snappedY, 100);
  assert.equal(r.guides.length, 0);
});

test("custom threshold respected", () => {
  const sibling = { x: 300, y: 100, w: 200, h: 80 };
  const dragged = { x: 312, y: 400, w: 200, h: 80 }; // 12 px off
  const r1 = computeSnap({ dragged, others: [sibling], bounds: BOUNDS, threshold: 6 });
  assert.equal(r1.snappedX, 312, "12px > threshold 6 — no snap");
  const r2 = computeSnap({ dragged, others: [sibling], bounds: BOUNDS, threshold: 15 });
  assert.equal(r2.snappedX, 300, "12px <= threshold 15 — snap");
});

test("snap independently per axis", () => {
  const sibling = { x: 300, y: 100, w: 200, h: 80 };
  // X is way off, Y is within threshold.
  const dragged = { x: 800, y: 102, w: 100, h: 50 };
  const r = computeSnap({ dragged, others: [sibling], bounds: BOUNDS });
  // X should not change (no candidate within threshold; check though that it
  // didn't accidentally snap to bounds.right=1080 — dragged.right=900, off
  // by 180).
  assert.equal(r.snappedX, 800);
  assert.equal(r.snappedY, 100);
});

test("guide range bridges dragged + target", () => {
  const sibling = { x: 300, y: 100, w: 200, h: 80 }; // y span 100..180
  const dragged = { x: 304, y: 600, w: 100, h: 50 }; // y span 600..650
  const r = computeSnap({ dragged, others: [sibling], bounds: BOUNDS });
  const v = r.guides.find((g) => g.orientation === "v" && Math.abs(g.position - 300) < 0.5);
  assert.ok(v, "expected vertical guide at x=300");
  assert.ok(v!.from <= 100, `guide should start at min(100,600), got ${v!.from}`);
  assert.ok(v!.to >= 650, `guide should end at max(180,650), got ${v!.to}`);
});
