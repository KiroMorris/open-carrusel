import { readDataSafe, writeData } from "./data";
import { generateId, now } from "./utils";
import type {
  Carousel,
  CarouselsData,
  Slide,
  AspectRatio,
  ReferenceImage,
  CanvasOverrides,
  SlideVersion,
} from "@/types/carousel";
import { MAX_SLIDES, MAX_VERSIONS } from "@/types/carousel";

/**
 * Migrate `CanvasOverrides` from the v1 schema (text-layers only) to v2
 * (text-layers + images + shapes). Idempotent and lossless: v2 input passes
 * through unchanged; v1 (or legacy missing-version) input gets empty
 * `images` / `shapes` maps + `schemaVersion: 2` baked in.
 *
 * v1 → v2 changes:
 *   - add `images: {}`
 *   - add `shapes: {}`
 *   - bump `schemaVersion` to 2
 *   - default `order` to `Object.keys(layers)` if missing
 *
 * Exported for direct testing and for use by API routes that construct
 * overrides from untrusted client JSON.
 */
export function migrateOverrides(
  o: CanvasOverrides | null | undefined | Record<string, unknown>
): CanvasOverrides | null {
  if (!o) return (o as null | undefined) ?? null;
  // Treat any non-object input as null — the data shape is corrupted.
  if (typeof o !== "object") return null;
  const raw = o as Record<string, unknown>;
  const layers =
    raw.layers && typeof raw.layers === "object"
      ? (raw.layers as CanvasOverrides["layers"])
      : {};
  const images =
    raw.images && typeof raw.images === "object"
      ? (raw.images as CanvasOverrides["images"])
      : {};
  const shapes =
    raw.shapes && typeof raw.shapes === "object"
      ? (raw.shapes as CanvasOverrides["shapes"])
      : {};
  const order = Array.isArray(raw.order)
    ? (raw.order as string[])
    : Object.keys(layers);
  return {
    layers,
    images,
    shapes,
    order,
    schemaVersion: 2,
  };
}

/**
 * Returns true iff the slide carries any non-empty canvas-refine overrides
 * (text, image-frame, or shape). Used by the API lock-guard and the chat
 * system prompt so all writers see the same semantics.
 */
export function isSlideLocked(
  slide?: Pick<Slide, "canvasOverrides"> | null
): boolean {
  const o = slide?.canvasOverrides;
  if (!o) return false;
  const layerCount = Object.keys(o.layers ?? {}).length;
  const imageCount = Object.keys(o.images ?? {}).length;
  const shapeCount = Object.keys(o.shapes ?? {}).length;
  return layerCount + imageCount + shapeCount > 0;
}

/** Coerce a previousVersions entry (legacy string OR new object) into the
 * structured shape. Use ONLY for reading; preserve raw entries on write so
 * we don't rewrite legacy data unnecessarily. */
function readVersionEntry(
  entry: SlideVersion
): { html: string; overrides: CanvasOverrides | null } {
  if (typeof entry === "string") {
    return { html: entry, overrides: null };
  }
  return { html: entry.html, overrides: entry.overrides ?? null };
}

const FILE = "carousels.json";

async function load(): Promise<CarouselsData> {
  const data = await readDataSafe<CarouselsData>(FILE, { carousels: [] });
  // Auto-upgrade canvasOverrides to v2 on read. The migration is lossless and
  // idempotent — slides without overrides stay null. The upgraded shape is
  // re-persisted the next time anything writes the carousel back to disk.
  for (const carousel of data.carousels ?? []) {
    for (const slide of carousel.slides ?? []) {
      if (slide.canvasOverrides) {
        slide.canvasOverrides = migrateOverrides(slide.canvasOverrides);
      }
      // Also migrate overrides embedded in previousVersions (undo history).
      if (Array.isArray(slide.previousVersions)) {
        slide.previousVersions = slide.previousVersions.map((entry) => {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry === "object" && entry.overrides) {
            return { ...entry, overrides: migrateOverrides(entry.overrides) };
          }
          return entry;
        });
      }
    }
  }
  return data;
}

async function save(data: CarouselsData): Promise<void> {
  await writeData(FILE, data);
}

export async function listCarousels(): Promise<Carousel[]> {
  const data = await load();
  return data.carousels.filter((c) => !c.isTemplate);
}

export async function getCarousel(id: string): Promise<Carousel | null> {
  const data = await load();
  return data.carousels.find((c) => c.id === id) ?? null;
}

export async function createCarousel(
  name: string,
  aspectRatio: AspectRatio
): Promise<Carousel> {
  const data = await load();
  const carousel: Carousel = {
    id: generateId(),
    name,
    aspectRatio,
    slides: [],
    referenceImages: [],
    chatSessionId: null,
    isTemplate: false,
    tags: [],
    createdAt: now(),
    updatedAt: now(),
  };
  data.carousels.push(carousel);
  await save(data);
  return carousel;
}

export async function updateCarousel(
  id: string,
  updates: Partial<Pick<Carousel, "name" | "aspectRatio" | "tags" | "chatSessionId" | "caption" | "hashtags">>
): Promise<Carousel | null> {
  const data = await load();
  const idx = data.carousels.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  Object.assign(data.carousels[idx], updates, { updatedAt: now() });
  await save(data);
  return data.carousels[idx];
}

export async function duplicateCarousel(id: string): Promise<Carousel | null> {
  const data = await load();
  const source = data.carousels.find((c) => c.id === id);
  if (!source) return null;

  const duplicate: Carousel = {
    ...source,
    id: generateId(),
    name: `${source.name} (copy)`,
    slides: source.slides.map((s) => ({
      ...s,
      id: generateId(),
      previousVersions: [],
    })),
    referenceImages: [...(source.referenceImages || [])],
    chatSessionId: null,
    isTemplate: false,
    createdAt: now(),
    updatedAt: now(),
  };

  data.carousels.push(duplicate);
  await save(data);
  return duplicate;
}

export async function deleteCarousel(id: string): Promise<boolean> {
  const data = await load();
  const idx = data.carousels.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  data.carousels.splice(idx, 1);
  await save(data);
  return true;
}

// --- Slide operations ---

export async function addSlide(
  carouselId: string,
  html: string,
  notes = "",
  canvasOverrides: CanvasOverrides | null = null
): Promise<Slide | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;
  if (carousel.slides.length >= MAX_SLIDES) return null;

  const slide: Slide = {
    id: generateId(),
    html,
    previousVersions: [],
    order: carousel.slides.length,
    notes,
    canvasOverrides,
  };
  carousel.slides.push(slide);
  carousel.updatedAt = now();
  await save(data);
  return slide;
}

export async function updateSlide(
  carouselId: string,
  slideId: string,
  updates: Partial<Pick<Slide, "html" | "notes" | "canvasOverrides">>
): Promise<Slide | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;
  const slide = carousel.slides.find((s) => s.id === slideId);
  if (!slide) return null;

  // Save current state to version history when html changes. New entries
  // capture both html AND overrides so undo restores the full canvas state.
  if (updates.html !== undefined && updates.html !== slide.html) {
    slide.previousVersions.push({
      html: slide.html,
      overrides: slide.canvasOverrides ?? null,
    });
    if (slide.previousVersions.length > MAX_VERSIONS) {
      slide.previousVersions.shift();
    }
  }

  // Migrate any inbound canvasOverrides up to v2 on the way in. Defends
  // against API clients still sending v1-shaped blobs.
  if (updates.canvasOverrides !== undefined) {
    updates = {
      ...updates,
      canvasOverrides: updates.canvasOverrides
        ? migrateOverrides(updates.canvasOverrides)
        : updates.canvasOverrides,
    };
  }

  Object.assign(slide, updates);
  carousel.updatedAt = now();
  await save(data);
  return slide;
}

/**
 * Atomic override-only update. Skips html version-history thrashing during
 * drag commits — the canvas editor pings this on every debounced change.
 */
export async function setCanvasOverrides(
  carouselId: string,
  slideId: string,
  overrides: CanvasOverrides | null
): Promise<Slide | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;
  const slide = carousel.slides.find((s) => s.id === slideId);
  if (!slide) return null;

  slide.canvasOverrides = overrides ? migrateOverrides(overrides) : overrides;
  carousel.updatedAt = now();
  await save(data);
  return slide;
}

export async function deleteSlide(
  carouselId: string,
  slideId: string
): Promise<boolean> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return false;
  const idx = carousel.slides.findIndex((s) => s.id === slideId);
  if (idx === -1) return false;

  carousel.slides.splice(idx, 1);
  // Re-order remaining slides
  carousel.slides.forEach((s, i) => {
    s.order = i;
  });
  carousel.updatedAt = now();
  await save(data);
  return true;
}

export async function reorderSlides(
  carouselId: string,
  slideIds: string[]
): Promise<boolean> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return false;

  const slideMap = new Map(carousel.slides.map((s) => [s.id, s]));
  const reordered: Slide[] = [];
  for (const id of slideIds) {
    const slide = slideMap.get(id);
    if (!slide) return false;
    slide.order = reordered.length;
    reordered.push(slide);
  }
  carousel.slides = reordered;
  carousel.updatedAt = now();
  await save(data);
  return true;
}

export async function undoSlide(
  carouselId: string,
  slideId: string
): Promise<Slide | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;
  const slide = carousel.slides.find((s) => s.id === slideId);
  if (!slide || slide.previousVersions.length === 0) return null;

  const previousEntry = slide.previousVersions.pop()!;
  const restored = readVersionEntry(previousEntry);
  slide.html = restored.html;
  // Legacy string entries don't carry overrides — leaving the slide's
  // current canvasOverrides in place would mis-pair them with the restored
  // (older) html. Safer to clear in that case so the slide is in a known
  // consistent state.
  if (typeof previousEntry === "string") {
    slide.canvasOverrides = null;
  } else {
    slide.canvasOverrides = restored.overrides
      ? migrateOverrides(restored.overrides)
      : restored.overrides;
  }
  carousel.updatedAt = now();
  await save(data);
  return slide;
}

// --- Reference images ---

export async function addReferenceImage(
  carouselId: string,
  image: ReferenceImage
): Promise<ReferenceImage | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;

  if (!carousel.referenceImages) carousel.referenceImages = [];
  carousel.referenceImages.push(image);
  carousel.updatedAt = now();
  await save(data);
  return image;
}

export async function removeReferenceImage(
  carouselId: string,
  imageId: string
): Promise<boolean> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel || !carousel.referenceImages) return false;

  const idx = carousel.referenceImages.findIndex((img) => img.id === imageId);
  if (idx === -1) return false;

  carousel.referenceImages.splice(idx, 1);
  carousel.updatedAt = now();
  await save(data);
  return true;
}
