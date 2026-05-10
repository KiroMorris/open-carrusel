import puppeteer, { type Browser } from "puppeteer";
import { readFile } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { wrapSlideHtml, extractFontFamilies } from "./slide-html";
import { getInlinedFontCSS } from "./fonts";
import { exportSlideVideo, hasAnimation } from "./export-video";
import type { Slide, AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

// Singleton browser with lifecycle management
let browser: Browser | null = null;
let exportCount = 0;
const MAX_EXPORTS_BEFORE_RESTART = 50;

async function getBrowser(): Promise<Browser> {
  if (browser && exportCount >= MAX_EXPORTS_BEFORE_RESTART) {
    await browser.close().catch(() => {});
    browser = null;
    exportCount = 0;
  }
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    exportCount = 0;
  }
  return browser;
}

/**
 * Inline all image references in slide HTML.
 * Replaces /uploads/xxx.png paths with data: URIs.
 */
async function inlineImages(html: string): Promise<string> {
  const uploadDir = path.resolve(process.cwd(), "public");
  const imgRegex = /(?:src=["']|url\(["']?)(\/uploads\/[^"'\s)]+)/g;
  const matches = [...html.matchAll(imgRegex)];

  let result = html;
  for (const match of matches) {
    const imgPath = match[1];
    try {
      const fullPath = path.join(uploadDir, imgPath);
      const buffer = await readFile(fullPath);
      const ext = path.extname(imgPath).toLowerCase();
      const mime =
        ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : "image/webp";
      const base64 = buffer.toString("base64");
      result = result.replace(imgPath, `data:${mime};base64,${base64}`);
    } catch {
      // Keep original path — Puppeteer can fetch from localhost
    }
  }

  return result;
}

/**
 * Export a single slide to PNG buffer.
 */
export async function exportSlide(
  slide: Slide,
  aspectRatio: AspectRatio
): Promise<Buffer> {
  const { width, height } = DIMENSIONS[aspectRatio];

  // Get inlined font CSS
  const fontFamilies = extractFontFamilies(slide.html);
  const inlinedFontCss = await getInlinedFontCSS(fontFamilies);

  // Inline images
  const inlinedHtml = await inlineImages(slide.html);

  // Build self-contained HTML. We pass canvasOverrides through so the merged
  // PNG matches the preview/refine view byte-for-byte. editorRuntime is
  // explicitly false — Puppeteer must NEVER execute the editor script.
  const fullHtml = wrapSlideHtml(inlinedHtml, aspectRatio, {
    inlineFontCss: inlinedFontCss,
    overrides: slide.canvasOverrides ?? null,
    editorRuntime: false,
    // BUG-021: Puppeteer doesn't run the editor runtime. Without "export"
    // mode, transform-only / style-only edits to existing layers are silently
    // dropped from the rendered PNG. Export mode forces every overridden
    // existing layer to be emitted as a replica.
    mode: "export",
  });

  const br = await getBrowser();
  const page = await br.newPage();

  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(fullHtml, { waitUntil: "domcontentloaded", timeout: 15000 });

    // Wait for fonts to be ready
    await page
      .waitForFunction(
        () =>
          document.fonts.ready.then(() =>
            [...document.fonts].every((f) => f.status === "loaded")
          ),
        { timeout: 10000 }
      )
      .catch(() => {
        // Font loading timeout — proceed with whatever loaded
      });

    const screenshotBuffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width, height },
    });

    exportCount++;

    // Post-process with Sharp: enforce sRGB
    const processed = await sharp(screenshotBuffer)
      .toColorspace("srgb")
      .png()
      .toBuffer();

    return processed;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Export all slides of a carousel.
 * Slides with CSS animation render as MP4; the rest render as PNG.
 * PNG slides batch concurrently; videos render serially (each is heavy).
 */
export async function exportAllSlides(
  slides: Slide[],
  aspectRatio: AspectRatio,
  onProgress?: (current: number, total: number) => void
): Promise<{ name: string; buffer: Buffer }[]> {
  const results: { name: string; buffer: Buffer }[] = new Array(slides.length);
  let done = 0;
  const tick = () => {
    done++;
    onProgress?.(done, slides.length);
  };

  // Split into PNG and MP4 work lists, preserving original index for filenames.
  const pngWork: { idx: number; slide: Slide }[] = [];
  const mp4Work: { idx: number; slide: Slide }[] = [];
  slides.forEach((slide, idx) => {
    if (hasAnimation(slide.html)) mp4Work.push({ idx, slide });
    else pngWork.push({ idx, slide });
  });

  // PNGs concurrently
  const CONCURRENCY = 3;
  for (let i = 0; i < pngWork.length; i += CONCURRENCY) {
    const batch = pngWork.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async ({ idx, slide }) => {
        const buffer = await exportSlide(slide, aspectRatio);
        results[idx] = { name: `slide-${idx + 1}.png`, buffer };
        tick();
      })
    );
  }

  // MP4s serially — each video render is CPU-heavy, parallel risks OOM/timeouts.
  for (const { idx, slide } of mp4Work) {
    try {
      const buffer = await exportSlideVideo(slide, aspectRatio, { durationSec: 4 });
      results[idx] = { name: `slide-${idx + 1}.mp4`, buffer };
    } catch (err) {
      // Fall back to PNG if video render fails (e.g. ffmpeg missing).
      console.warn(
        `Video export for slide ${idx + 1} failed, falling back to PNG:`,
        err instanceof Error ? err.message : err
      );
      const buffer = await exportSlide(slide, aspectRatio);
      results[idx] = { name: `slide-${idx + 1}.png`, buffer };
    }
    tick();
  }

  return results;
}
