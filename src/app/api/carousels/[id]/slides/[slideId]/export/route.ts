import { NextResponse } from "next/server";
import { getCarousel } from "@/lib/carousels";
import { exportSlide } from "@/lib/export-slides";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; slideId: string }> }
) {
  const { id, slideId } = await params;
  const carousel = await getCarousel(id);

  if (!carousel) {
    return NextResponse.json({ error: "Carousel not found" }, { status: 404 });
  }

  const slideIndex = carousel.slides.findIndex((s) => s.id === slideId);
  if (slideIndex === -1) {
    return NextResponse.json({ error: "Slide not found" }, { status: 404 });
  }

  try {
    const buffer = await exportSlide(
      carousel.slides[slideIndex],
      carousel.aspectRatio
    );

    const safeName = carousel.name.replace(/[^a-zA-Z0-9-_]/g, "_");
    const filename = `${safeName}-slide-${slideIndex + 1}.png`;

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("Single slide export error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Export failed: ${message}` },
      { status: 500 }
    );
  }
}
