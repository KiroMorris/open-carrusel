import { NextResponse } from "next/server";
import { updateSlide, deleteSlide, getCarousel } from "@/lib/carousels";

/**
 * Phase 5 lock guard. A slide is "locked" when it has non-empty
 * canvasOverrides — the user has hand-refined it in the canvas editor and
 * Claude (or any non-canvas writer) must not blow away those edits without an
 * explicit override.
 */
function isSlideLocked(slide: { canvasOverrides?: { layers?: Record<string, unknown> } | null } | undefined): boolean {
  return (
    !!slide?.canvasOverrides &&
    Object.keys(slide.canvasOverrides.layers ?? {}).length > 0
  );
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; slideId: string }> }
) {
  const { id, slideId } = await params;
  try {
    const body = await request.json();
    const source = request.headers.get("X-OC-Source") ?? "chat";

    const carousel = await getCarousel(id);
    const existing = carousel?.slides.find((s) => s.id === slideId);
    if (existing && isSlideLocked(existing) && source !== "canvas" && !body.force) {
      return NextResponse.json(
        {
          error:
            "Slide is locked by canvas refine mode. Use the unlock endpoint or pass force: true.",
          code: "SLIDE_LOCKED",
        },
        { status: 423 }
      );
    }

    // Strip the `force` flag — it is a guard parameter, not a slide field.
    const { force: _force, ...updates } = body;
    void _force;

    const slide = await updateSlide(id, slideId, updates);
    if (!slide) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(slide);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; slideId: string }> }
) {
  const { id, slideId } = await params;
  const source = request.headers.get("X-OC-Source") ?? "chat";

  const carousel = await getCarousel(id);
  const existing = carousel?.slides.find((s) => s.id === slideId);
  // Deletion is too destructive to escape via a `force` body flag; only the
  // canvas editor (which knows the slide is locked) may delete a locked slide.
  if (existing && isSlideLocked(existing) && source !== "canvas") {
    return NextResponse.json(
      {
        error:
          "Slide is locked by canvas refine mode. Unlock it from the canvas toolbar before deleting.",
        code: "SLIDE_LOCKED",
      },
      { status: 423 }
    );
  }

  const deleted = await deleteSlide(id, slideId);
  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
