/**
 * useSnap — pure snap/alignment math.
 *
 * Phase 4. Zero React, zero DOM. Single exported pure function `computeSnap`.
 * (The "use" prefix is kept for naming continuity with the plan; consumers
 * call `computeSnap` directly inside their pointer-move handler — no
 * `useEffect`/`useState` involved.)
 *
 * Given a dragged layer's bbox, sibling bboxes, and slide bounds, return:
 *   { snappedX, snappedY, guides }
 *
 * Snap rules (in priority order — first hit within threshold wins for each
 * axis, but we keep emitting guide segments for ALL same-axis matches that
 * land on the chosen position so the user sees every aligned edge):
 *
 *   X axis (vertical guide lines):
 *     - dragged.left   → other.left  | other.center | other.right | bounds.left | bounds.center | bounds.right
 *     - dragged.center → same set
 *     - dragged.right  → same set
 *
 *   Y axis (horizontal guide lines): mirror.
 *
 * Threshold defaults to 6 px (slide coords). When `disabled` (Alt held), the
 * function short-circuits and returns the raw position with no guides.
 *
 * Why pure: snap math is the easiest thing in the editor to break and the
 * easiest thing to test. We isolate it from React/DOM so a single
 * `node --test` run can prove every branch.
 */

export interface SnapBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapBounds {
  w: number;
  h: number;
}

export type GuideOrientation = "v" | "h";

export interface SnapGuide {
  /** "v" = vertical line (constant x), "h" = horizontal line (constant y). */
  orientation: GuideOrientation;
  /** The fixed coordinate value (x for vertical, y for horizontal). */
  position: number;
  /** Range along the OTHER axis to draw the guide line across. */
  from: number;
  to: number;
}

export interface SnapInput {
  dragged: SnapBox;
  others: SnapBox[];
  bounds: SnapBounds;
  threshold?: number;
  disabled?: boolean;
}

export interface SnapResult {
  snappedX: number;
  snappedY: number;
  guides: SnapGuide[];
}

const DEFAULT_THRESHOLD = 6;

/**
 * Three anchor positions per box on each axis: leading edge, center, trailing
 * edge. A snap candidate exists for every (dragged-anchor, target-anchor)
 * pair. The chosen snap minimizes the resulting distance between dragged
 * anchor and target anchor.
 */
type AnchorKey = "leading" | "center" | "trailing";

interface AxisAnchor {
  key: AnchorKey;
  /** Coordinate on the snap axis. */
  coord: number;
  /** Source identifier — used to dedupe guides per target. */
  sourceId: string;
  /** Range along the OTHER axis (for drawing guide segments). */
  otherFrom: number;
  otherTo: number;
}

function anchorsForBoxX(box: SnapBox, sourceId: string): AxisAnchor[] {
  // Vertical guides span box's vertical extent (y..y+h).
  return [
    { key: "leading", coord: box.x, sourceId, otherFrom: box.y, otherTo: box.y + box.h },
    {
      key: "center",
      coord: box.x + box.w / 2,
      sourceId,
      otherFrom: box.y,
      otherTo: box.y + box.h,
    },
    {
      key: "trailing",
      coord: box.x + box.w,
      sourceId,
      otherFrom: box.y,
      otherTo: box.y + box.h,
    },
  ];
}

function anchorsForBoxY(box: SnapBox, sourceId: string): AxisAnchor[] {
  // Horizontal guides span box's horizontal extent (x..x+w).
  return [
    { key: "leading", coord: box.y, sourceId, otherFrom: box.x, otherTo: box.x + box.w },
    {
      key: "center",
      coord: box.y + box.h / 2,
      sourceId,
      otherFrom: box.x,
      otherTo: box.x + box.w,
    },
    {
      key: "trailing",
      coord: box.y + box.h,
      sourceId,
      otherFrom: box.x,
      otherTo: box.x + box.w,
    },
  ];
}

function boundsAnchorsX(bounds: SnapBounds): AxisAnchor[] {
  return [
    { key: "leading", coord: 0, sourceId: "bounds", otherFrom: 0, otherTo: bounds.h },
    {
      key: "center",
      coord: bounds.w / 2,
      sourceId: "bounds",
      otherFrom: 0,
      otherTo: bounds.h,
    },
    {
      key: "trailing",
      coord: bounds.w,
      sourceId: "bounds",
      otherFrom: 0,
      otherTo: bounds.h,
    },
  ];
}

function boundsAnchorsY(bounds: SnapBounds): AxisAnchor[] {
  return [
    { key: "leading", coord: 0, sourceId: "bounds", otherFrom: 0, otherTo: bounds.w },
    {
      key: "center",
      coord: bounds.h / 2,
      sourceId: "bounds",
      otherFrom: 0,
      otherTo: bounds.w,
    },
    {
      key: "trailing",
      coord: bounds.h,
      sourceId: "bounds",
      otherFrom: 0,
      otherTo: bounds.w,
    },
  ];
}

/**
 * For a single axis: pick the snap delta that minimizes |dragged-anchor -
 * target-anchor| across all (drag-anchor × target-anchor) pairs that fall
 * within the threshold. Returns the winning delta + the guide(s) to draw.
 */
function snapAxis(
  draggedAnchors: AxisAnchor[],
  targetAnchors: AxisAnchor[],
  threshold: number
): { delta: number; guides: { coord: number; otherFrom: number; otherTo: number }[] } {
  let best: { delta: number; coord: number } | null = null;
  for (const da of draggedAnchors) {
    for (const ta of targetAnchors) {
      const delta = ta.coord - da.coord;
      if (Math.abs(delta) <= threshold) {
        if (!best || Math.abs(delta) < Math.abs(best.delta)) {
          best = { delta, coord: ta.coord };
        }
      }
    }
  }
  if (!best) return { delta: 0, guides: [] };

  // Collect every guide that lands on the chosen target coord (any drag
  // anchor that — after applying delta — sits on that coord). This is what
  // makes Figma-style "every edge that lined up" rendering possible.
  const winningCoord = best.coord;
  const guides: { coord: number; otherFrom: number; otherTo: number }[] = [];
  const seen = new Set<string>();
  for (const ta of targetAnchors) {
    if (Math.abs(ta.coord - winningCoord) > 0.5) continue;
    const key = `${ta.sourceId}:${ta.coord.toFixed(2)}:${ta.otherFrom.toFixed(2)}:${ta.otherTo.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    guides.push({ coord: ta.coord, otherFrom: ta.otherFrom, otherTo: ta.otherTo });
  }
  return { delta: best.delta, guides };
}

/**
 * Compute the snapped position of a dragged layer.
 *
 * Snapping is independent per axis: a layer can snap horizontally without
 * snapping vertically and vice versa. That matches Figma/Sketch behavior
 * and keeps the math simple.
 */
export function computeSnap(input: SnapInput): SnapResult {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const { dragged, others, bounds, disabled } = input;

  if (disabled) {
    return { snappedX: dragged.x, snappedY: dragged.y, guides: [] };
  }

  // X axis ------------------------------------------------------------------
  const dragXAnchors = anchorsForBoxX(dragged, "dragged");
  const targetXAnchors: AxisAnchor[] = [];
  others.forEach((o, i) => {
    targetXAnchors.push(...anchorsForBoxX(o, `other-${i}`));
  });
  targetXAnchors.push(...boundsAnchorsX(bounds));
  const xResult = snapAxis(dragXAnchors, targetXAnchors, threshold);

  // Y axis ------------------------------------------------------------------
  const dragYAnchors = anchorsForBoxY(dragged, "dragged");
  const targetYAnchors: AxisAnchor[] = [];
  others.forEach((o, i) => {
    targetYAnchors.push(...anchorsForBoxY(o, `other-${i}`));
  });
  targetYAnchors.push(...boundsAnchorsY(bounds));
  const yResult = snapAxis(dragYAnchors, targetYAnchors, threshold);

  const snappedX = dragged.x + xResult.delta;
  const snappedY = dragged.y + yResult.delta;

  // Build guide segments. The "from"/"to" range for each guide spans both
  // the matched target box AND the dragged box (post-snap), so the guide
  // visibly bridges them.
  const postSnapDragged: SnapBox = {
    x: snappedX,
    y: snappedY,
    w: dragged.w,
    h: dragged.h,
  };

  const guides: SnapGuide[] = [];
  for (const g of xResult.guides) {
    const from = Math.min(g.otherFrom, postSnapDragged.y);
    const to = Math.max(g.otherTo, postSnapDragged.y + postSnapDragged.h);
    guides.push({ orientation: "v", position: g.coord, from, to });
  }
  for (const g of yResult.guides) {
    const from = Math.min(g.otherFrom, postSnapDragged.x);
    const to = Math.max(g.otherTo, postSnapDragged.x + postSnapDragged.w);
    guides.push({ orientation: "h", position: g.coord, from, to });
  }

  return { snappedX, snappedY, guides };
}
