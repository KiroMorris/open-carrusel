import { NextResponse } from "next/server";
import { getCarousel } from "@/lib/carousels";
import { exportSlideVideo, hasAnimation } from "@/lib/export-video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; slideId: string }> }
) {
  const { id, slideId } = await params;
  const carousel = await getCarousel(id);
  if (!carousel) {
    return NextResponse.json({ error: "Carousel not found" }, { status: 404 });
  }
  const idx = carousel.slides.findIndex((s) => s.id === slideId);
  if (idx === -1) {
    return NextResponse.json({ error: "Slide not found" }, { status: 404 });
  }
  const slide = carousel.slides[idx];

  if (!hasAnimation(slide.html)) {
    return NextResponse.json(
      { error: "This slide has no animation — use the PNG export instead." },
      { status: 400 }
    );
  }

  // Optional ?seconds=N override; default 4s.
  const url = new URL(request.url);
  const secParam = url.searchParams.get("seconds");
  const durationSec = secParam ? Math.max(1, Math.min(15, parseInt(secParam, 10) || 4)) : 4;

  try {
    const buffer = await exportSlideVideo(slide, carousel.aspectRatio, { durationSec });
    const safeName = carousel.name.replace(/[^a-zA-Z0-9-_]/g, "_");
    const filename = `${safeName}-slide-${idx + 1}.mp4`;
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("Video export error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const ffmpegMissing = /ENOENT|spawn ffmpeg/.test(message);
    return NextResponse.json(
      {
        error: ffmpegMissing
          ? "ffmpeg not found on PATH. Install with: brew install ffmpeg"
          : `Video export failed: ${message}`,
      },
      { status: 500 }
    );
  }
}

// GET → tell the UI whether this slide has animation (cheap probe).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; slideId: string }> }
) {
  const { id, slideId } = await params;
  const carousel = await getCarousel(id);
  if (!carousel) {
    return NextResponse.json({ error: "Carousel not found" }, { status: 404 });
  }
  const slide = carousel.slides.find((s) => s.id === slideId);
  if (!slide) {
    return NextResponse.json({ error: "Slide not found" }, { status: 404 });
  }
  return NextResponse.json({ animated: hasAnimation(slide.html) });
}
