import type { AspectRatio, CanvasOverrides } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import { applyOverrides } from "./canvas-overrides";
import { EDITOR_RUNTIME_JS } from "./editor-runtime.bundle";

/**
 * Extract Google Font family names from slide HTML.
 * Looks for font-family declarations in inline styles and <style> tags.
 */
export function extractFontFamilies(html: string): string[] {
  const families = new Set<string>();
  // Match font-family: "Font Name" or font-family: 'Font Name' or font-family: Font Name
  const regex = /font-family:\s*['"]?([^;'"}\n]+?)['"]?\s*[;}"]/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const raw = match[1].trim();
    // Split on commas and take non-generic font names
    const generics = new Set([
      "serif",
      "sans-serif",
      "monospace",
      "cursive",
      "fantasy",
      "system-ui",
      "inherit",
      "initial",
      "unset",
    ]);
    for (const part of raw.split(",")) {
      const name = part.trim().replace(/['"]/g, "");
      if (name && !generics.has(name.toLowerCase())) {
        families.add(name);
      }
    }
  }
  return Array.from(families);
}

/**
 * Wraps slide body HTML into a full HTML document at the correct dimensions.
 * This is THE shared rendering contract between preview (iframe) and export (Puppeteer).
 *
 * Optional `overrides` are applied to `slideHtml` BEFORE the body is
 * interpolated, so the resulting document contains the merged layout.
 *
 * `editorRuntime` is reserved for Phase 2 (Refine mode iframe). It defaults
 * to false and Phase 1 emits no `<script>` either way — the export pipeline
 * should NEVER pass true. A defensive check at the bottom of this function
 * throws if export-time code accidentally enables it.
 */
export function wrapSlideHtml(
  slideHtml: string,
  aspectRatio: AspectRatio,
  options?: {
    inlineFontCss?: string;
    overrides?: CanvasOverrides | null;
    editorRuntime?: boolean;
  }
): string {
  const { width, height } = DIMENSIONS[aspectRatio];
  // Apply overrides BEFORE we extract fonts so any new layer's font-family
  // is picked up in the Google Fonts <link>.
  const mergedHtml = options?.overrides
    ? applyOverrides(slideHtml, options.overrides)
    : slideHtml;
  const fontFamilies = extractFontFamilies(mergedHtml);

  let fontBlock = "";
  if (options?.inlineFontCss) {
    // For export: use inlined base64 @font-face CSS
    fontBlock = `<style>${options.inlineFontCss}</style>`;
  } else if (fontFamilies.length > 0) {
    // For preview: use Google Fonts CDN link
    const params = fontFamilies
      .map(
        (f) =>
          `family=${encodeURIComponent(f)}:wght@300;400;500;600;700;800`
      )
      .join("&");
    fontBlock = `<link href="https://fonts.googleapis.com/css2?${params}&display=swap" rel="stylesheet">`;
  }

  // Phase 2: inject the editor runtime <script> when editorRuntime is true.
  // Export call sites (`export-slides.ts`, `export-video.ts`) pass
  // `editorRuntime: false` explicitly so PNG/MP4 output never bakes the
  // runtime in. The runtime is the ONLY <script> tag we ever emit; if you
  // see a `<script>` in export output, something is very wrong.
  const wantsEditorRuntime = options?.editorRuntime === true;
  const editorRuntimeBlock = wantsEditorRuntime
    ? `\n  <script data-oc-editor-runtime="1">${EDITOR_RUNTIME_JS}</script>\n`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${width}, initial-scale=1">
  ${fontBlock}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  </style>
</head>
<body>
  ${mergedHtml}${editorRuntimeBlock}
</body>
</html>`;
}
