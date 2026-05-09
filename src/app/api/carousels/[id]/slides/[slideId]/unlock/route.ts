import { NextResponse } from "next/server";
import { getCarousel, updateSlide } from "@/lib/carousels";
import { applyOverrides } from "@/lib/canvas-overrides";

/**
 * POST /api/carousels/[id]/slides/[slideId]/unlock?keepText=true|false
 *
 * Clears the slide's `canvasOverrides` so Claude (and any other writer) may
 * modify the slide again. Two behaviors:
 *
 * - `keepText=true` (default): bake the current overrides into the slide HTML
 *   one final time using `applyOverrides()`, then clear `canvasOverrides`.
 *   The visual stays the same; the JSON shape just no longer carries layer
 *   metadata. This is the path users will hit ~always.
 *
 * - `keepText=false`: simply clear `canvasOverrides` and revert to Claude's
 *   original HTML. Useful as a hard reset.
 *
 * Both paths push a history entry through `updateSlide()` (its built-in
 * version-history capture fires whenever `html` differs), so the user can
 * `undo` to get back to the locked state.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; slideId: string }> }
) {
  const { id, slideId } = await params;
  const url = new URL(request.url);
  // default: keepText=true
  const keepText = url.searchParams.get("keepText") !== "false";

  const carousel = await getCarousel(id);
  const slide = carousel?.slides.find((s) => s.id === slideId);
  if (!slide) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // No overrides → nothing to unlock. Treat as a no-op success so the UI can
  // call this endpoint defensively without erroring.
  const hasOverrides =
    !!slide.canvasOverrides &&
    Object.keys(slide.canvasOverrides.layers).length > 0;
  if (!hasOverrides) {
    return NextResponse.json(slide);
  }

  let nextHtml = slide.html;
  if (keepText) {
    // Bake the absolute-positioned override layers directly into the stored
    // HTML so the rendered output stays pixel-identical after the override
    // metadata is dropped.
    nextHtml = applyOverrides(slide.html, slide.canvasOverrides ?? null);
  }

  const updated = await updateSlide(id, slideId, {
    html: nextHtml,
    canvasOverrides: null,
  });
  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(updated);
}
