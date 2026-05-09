import { spawn } from "child_process";
import puppeteer, { type Browser } from "puppeteer";
import { readFile } from "fs/promises";
import path from "path";
import { wrapSlideHtml, extractFontFamilies } from "./slide-html";
import { getInlinedFontCSS } from "./fonts";
import type { Slide, AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

let videoBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!videoBrowser || !videoBrowser.isConnected()) {
    videoBrowser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
  }
  return videoBrowser;
}

/**
 * Cheap heuristic: does this slide contain CSS animations we should record?
 * Looks for @keyframes blocks or `animation:` shorthand in <style> blocks/inline.
 * Skips `transition:` (those need user interaction).
 */
export function hasAnimation(html: string): boolean {
  if (!html) return false;
  if (/@keyframes\s+[\w-]+/i.test(html)) return true;
  // animation: name duration easing — but ignore "animation: none"
  if (/animation\s*:\s*(?!none\b)[^;}\n]+/i.test(html)) return true;
  return false;
}

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
      // keep original
    }
  }
  return result;
}

/**
 * Render the slide in headless Chrome, screenshot N frames at 30 fps,
 * pipe them into ffmpeg, return an MP4 buffer.
 */
export async function exportSlideVideo(
  slide: Slide,
  aspectRatio: AspectRatio,
  options: { durationSec?: number; fps?: number } = {}
): Promise<Buffer> {
  const durationSec = options.durationSec ?? 4;
  const fps = options.fps ?? 30;
  const totalFrames = durationSec * fps;
  const { width, height } = DIMENSIONS[aspectRatio];

  const fontFamilies = extractFontFamilies(slide.html);
  const inlinedFontCss = await getInlinedFontCSS(fontFamilies);
  const inlinedHtml = await inlineImages(slide.html);
  const fullHtml = wrapSlideHtml(inlinedHtml, aspectRatio, {
    inlineFontCss: inlinedFontCss,
  });

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(fullHtml, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Wait for fonts
    await page
      .waitForFunction(
        () =>
          document.fonts.ready.then(() =>
            [...document.fonts].every((f) => f.status === "loaded")
          ),
        { timeout: 10000 }
      )
      .catch(() => {});

    // Spawn ffmpeg with image2pipe stdin → MP4 stdout
    const ff = spawn(
      "ffmpeg",
      [
        "-y",
        "-f", "image2pipe",
        "-framerate", String(fps),
        "-i", "-",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-preset", "medium",
        "-crf", "20",
        "-vf", `scale=${width}:${height}:flags=lanczos`,
        "-r", String(fps),
        "-f", "mp4",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    const chunks: Buffer[] = [];
    let stderrLog = "";
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.stderr.on("data", (c: Buffer) => {
      stderrLog += c.toString();
    });

    const ffmpegDone = new Promise<void>((resolve, reject) => {
      ff.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderrLog.slice(-500)}`));
      });
      ff.on("error", reject);
    });

    // Capture frames at a steady cadence and pipe to ffmpeg.
    // We use page.screenshot() in a tight loop. This is slower than CDP screencast
    // but more reliable across Chrome/Puppeteer versions.
    const frameIntervalMs = 1000 / fps;
    const startTime = Date.now();

    for (let i = 0; i < totalFrames; i++) {
      const targetMs = i * frameIntervalMs;
      const drift = Date.now() - startTime - targetMs;
      if (drift < 0) {
        await new Promise((r) => setTimeout(r, -drift));
      }
      const frame = (await page.screenshot({
        type: "jpeg",
        quality: 90,
        clip: { x: 0, y: 0, width, height },
        optimizeForSpeed: true,
      })) as Buffer;
      if (!ff.stdin.write(frame)) {
        await new Promise<void>((r) => ff.stdin.once("drain", () => r()));
      }
    }

    ff.stdin.end();
    await ffmpegDone;

    return Buffer.concat(chunks);
  } finally {
    await page.close().catch(() => {});
  }
}
