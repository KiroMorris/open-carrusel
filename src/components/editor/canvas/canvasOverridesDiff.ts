/**
 * Phase 6 — Canvas overrides diff helper.
 *
 * Computes the delta between `prev` and `next` `CanvasOverrides` snapshots
 * and ships per-id `apply-*` postMessages to the runtime. Pulled out of
 * `CanvasIframe.tsx` so the rafThrottle wrapper can call it cleanly without
 * closing over render-time state, AND so the file stays inside the project's
 * 300-line component-file convention.
 *
 * Pure function — no React, no module-level state. Easily unit-testable.
 */

import type { CanvasOverrides } from "@/types/carousel";
import type { ParentToIframeMessage } from "@/types/canvas";

export function runOverridesDiff(
  next: CanvasOverrides | null,
  prev: CanvasOverrides | null,
  send: (msg: ParentToIframeMessage) => void
): void {
  // --- Text layers ----------------------------------------------------------
  if (next) {
    for (const id of next.order) {
      const layer = next.layers[id];
      if (!layer) continue;
      const prevLayer = prev?.layers[id];
      const changed =
        !prevLayer ||
        JSON.stringify(prevLayer.transform) !== JSON.stringify(layer.transform) ||
        JSON.stringify(prevLayer.style) !== JSON.stringify(layer.style);

      if (!prevLayer && layer.kind === "new") {
        send({ type: "oc:editor:add-layer", payload: { layer } });
      } else if (changed) {
        send({
          type: "oc:editor:apply-transform",
          payload: { id, transform: layer.transform },
        });
        send({
          type: "oc:editor:apply-style",
          payload: { id, style: layer.style },
        });
      }
      if (layer.text != null && layer.text !== prevLayer?.text) {
        send({ type: "oc:editor:apply-text", payload: { id, text: layer.text } });
      }
    }
  }

  // --- Image overrides ------------------------------------------------------
  const nextImages = next?.images ?? {};
  const prevImages = prev?.images ?? {};
  for (const id of Object.keys(nextImages)) {
    const cur = nextImages[id];
    const prv = prevImages[id];
    if (!cur) continue;
    const changed =
      !prv ||
      JSON.stringify(prv.frame) !== JSON.stringify(cur.frame) ||
      JSON.stringify(prv.image) !== JSON.stringify(cur.image);
    if (changed) {
      send({
        type: "oc:editor:apply-image-transform",
        payload: { id, frame: cur.frame, image: cur.image },
      });
    }
  }

  // --- Shape overrides ------------------------------------------------------
  const nextShapes = next?.shapes ?? {};
  const prevShapes = prev?.shapes ?? {};
  for (const id of Object.keys(nextShapes)) {
    const cur = nextShapes[id];
    const prv = prevShapes[id];
    if (!cur) continue;
    const changed =
      !prv || JSON.stringify(prv.frame) !== JSON.stringify(cur.frame);
    if (changed) {
      send({
        type: "oc:editor:apply-shape-transform",
        payload: { id, frame: cur.frame },
      });
    }
  }

  // --- Deletions (text only — see comment) ----------------------------------
  // Image / shape deletes have no runtime path in Phase 2 — the next
  // apply-image-transform with the natural rect performs the implicit
  // revert. We only forward `delete-layer` for genuine text layer drops.
  if (prev) {
    for (const id of prev.order) {
      if (!next?.layers[id]) {
        const isImage = !!prevImages[id];
        const isShape = !!prevShapes[id];
        if (!isImage && !isShape) {
          send({ type: "oc:editor:delete-layer", payload: { id } });
        }
      }
    }
  }
}
