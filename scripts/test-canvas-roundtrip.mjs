#!/usr/bin/env node
/**
 * Phase 6 — Canvas overrides round-trip smoke test.
 *
 * NOT in the unit-test suite. Run on demand against a live `next dev` server:
 *
 *   npm run dev      # in another terminal
 *   node scripts/test-canvas-roundtrip.mjs
 *
 * Walks the full canvas-mode lifecycle to verify every layer plays nicely:
 *
 *   1. Pick a slide. PUT a canvas override (move title +50px) with
 *      X-OC-Source: canvas → 200 OK and persisted shape round-trips on GET.
 *   2. POST /export → PNG returned, valid header bytes, md5 differs from a
 *      pre-override export.
 *   3. POST /unlock?keepText=true → slide HTML now contains the baked-in
 *      data-oc-layer-id markup; canvasOverrides cleared.
 *   4. PUT (no canvas header, no force) → succeeds (slide is no longer
 *      locked).
 *   5. Lock-guard sanity: re-add overrides, then PUT { force: true } as
 *      chat-source → succeeds (force bypass).
 *   6. Restore the slide to its original HTML so the script is idempotent.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const BASE = process.env.OC_BASE ?? "http://localhost:3000";
const CAROUSEL_ID = "744eaa7b-707d-4ee8-93d8-bc8c4d139264";
const SLIDE_ID = "33e4fa1d-4abf-415e-992d-dd41fa86e15f"; // slide 3, Madame X

const md5 = (buf) => createHash("md5").update(buf).digest("hex");

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ok  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

async function getSlide() {
  const r = await fetch(`${BASE}/api/carousels/${CAROUSEL_ID}`);
  if (!r.ok) throw new Error(`GET carousel failed: ${r.status}`);
  const c = await r.json();
  return c.slides.find((s) => s.id === SLIDE_ID);
}

async function exportSlide() {
  const r = await fetch(
    `${BASE}/api/carousels/${CAROUSEL_ID}/slides/${SLIDE_ID}/export`,
    { method: "POST" }
  );
  if (!r.ok) throw new Error(`export failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function putSlide(body, headers = {}) {
  return fetch(`${BASE}/api/carousels/${CAROUSEL_ID}/slides/${SLIDE_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function unlock(keepText = "true") {
  return fetch(
    `${BASE}/api/carousels/${CAROUSEL_ID}/slides/${SLIDE_ID}/unlock?keepText=${keepText}`,
    { method: "POST" }
  );
}

(async () => {
  console.log(`\nCanvas round-trip smoke test against ${BASE}\n`);

  // Snapshot the slide so we can restore at the end.
  const original = await getSlide();
  if (!original) {
    console.error("Slide not found; aborting.");
    process.exit(1);
  }
  const originalHtml = original.html;
  const originalOverrides = original.canvasOverrides ?? null;

  // -------------------------------------------------------------------------
  // 1. Baseline export (no overrides yet) — record md5.
  // -------------------------------------------------------------------------
  console.log("Step 1 — baseline export");
  // Make sure we start clean.
  if (originalOverrides) {
    await unlock("false");
  }
  const baseline = await exportSlide();
  const baselineMd5 = md5(baseline);
  check(
    "baseline PNG starts with PNG magic bytes",
    baseline.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  );
  console.log(`     md5=${baselineMd5} bytes=${baseline.length}`);

  // -------------------------------------------------------------------------
  // 2. PUT a canvas override (synthetic title-shifted layer).
  // -------------------------------------------------------------------------
  console.log("Step 2 — PUT canvas override (X-OC-Source: canvas)");
  const fakeLayerId = "oc-roundtrip-title";
  const overrides = {
    schemaVersion: 1,
    order: [fakeLayerId],
    layers: {
      [fakeLayerId]: {
        id: fakeLayerId,
        kind: "new",
        text: "Phase 6 round-trip",
        transform: { x: 50, y: 100, w: 600, h: 80, rotation: 0, z: 0 },
        style: { fontSize: 48, color: "#ff0000", fontFamily: "Inter" },
      },
    },
  };
  const putRes = await putSlide(
    { canvasOverrides: overrides },
    { "X-OC-Source": "canvas" }
  );
  check("PUT canvas override returns 200", putRes.ok, `status=${putRes.status}`);
  const afterPut = await getSlide();
  check(
    "GET slide returns the override we wrote",
    afterPut?.canvasOverrides?.layers?.[fakeLayerId]?.text ===
      "Phase 6 round-trip"
  );
  check(
    "transform.x round-trips intact",
    afterPut?.canvasOverrides?.layers?.[fakeLayerId]?.transform?.x === 50
  );

  // -------------------------------------------------------------------------
  // 3. Export with overrides — verify PNG differs from baseline.
  // -------------------------------------------------------------------------
  console.log("Step 3 — export with overrides applied");
  const overridden = await exportSlide();
  const overriddenMd5 = md5(overridden);
  check(
    "overridden PNG starts with PNG magic bytes",
    overridden.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  );
  check(
    "overridden PNG md5 differs from baseline",
    overriddenMd5 !== baselineMd5,
    `both=${overriddenMd5}`
  );
  console.log(`     md5=${overriddenMd5} bytes=${overridden.length}`);

  // -------------------------------------------------------------------------
  // 4. Lock guard — non-canvas PUT without force should be rejected (423).
  // -------------------------------------------------------------------------
  console.log("Step 4 — lock guard rejects chat-source PUT");
  const blocked = await putSlide({ html: "<div>chat trying to clobber</div>" });
  check(
    "PUT without canvas header is rejected with 423",
    blocked.status === 423,
    `got status=${blocked.status}`
  );

  // -------------------------------------------------------------------------
  // 5. Lock-guard `force: true` bypass.
  // -------------------------------------------------------------------------
  console.log("Step 5 — lock guard accepts force:true bypass (chat-source)");
  const forced = await putSlide({ notes: "Phase 6 force-bypass test", force: true });
  check("PUT with force:true returns 200", forced.ok, `status=${forced.status}`);
  const afterForce = await getSlide();
  check("`force` flag is stripped from persisted slide", !("force" in (afterForce ?? {})));

  // -------------------------------------------------------------------------
  // 6. Unlock with keepText=true → HTML now carries baked override markup.
  // -------------------------------------------------------------------------
  console.log("Step 6 — POST /unlock?keepText=true");
  const unlockRes = await unlock("true");
  check("unlock returns 200", unlockRes.ok, `status=${unlockRes.status}`);
  const unlocked = await unlockRes.json();
  check("canvasOverrides is null after unlock", unlocked.canvasOverrides == null);
  check(
    "slide html now contains the baked layer marker",
    typeof unlocked.html === "string" &&
      unlocked.html.includes(`data-oc-layer-id="${fakeLayerId}"`)
  );

  // -------------------------------------------------------------------------
  // 7. PUT (chat-source, no force) now succeeds — slide is unlocked.
  // -------------------------------------------------------------------------
  console.log("Step 7 — chat-source PUT succeeds after unlock");
  const reopen = await putSlide({ notes: "Phase 6 unlocked write" });
  check("PUT after unlock returns 200", reopen.ok, `status=${reopen.status}`);

  // -------------------------------------------------------------------------
  // 8. ?keepText=invalid → falls back to default (true). Re-create override
  //    and verify the bake-in path runs (HTML grows + override clears).
  // -------------------------------------------------------------------------
  console.log("Step 8 — ?keepText=invalid falls back to default (true)");
  await putSlide(
    { canvasOverrides: overrides },
    { "X-OC-Source": "canvas" }
  );
  const beforeInvalid = await getSlide();
  const beforeLen = beforeInvalid?.html?.length ?? 0;
  const invalidRes = await fetch(
    `${BASE}/api/carousels/${CAROUSEL_ID}/slides/${SLIDE_ID}/unlock?keepText=invalid`,
    { method: "POST" }
  );
  check("unlock with invalid keepText returns 200", invalidRes.ok);
  const afterInvalid = await invalidRes.json();
  check(
    "invalid keepText behaved like keepText=true (html grew with marker)",
    typeof afterInvalid.html === "string" &&
      afterInvalid.html.includes(`data-oc-layer-id="${fakeLayerId}"`) &&
      afterInvalid.html.length >= beforeLen
  );

  // -------------------------------------------------------------------------
  // Restore.
  // -------------------------------------------------------------------------
  console.log("Restoring original slide state…");
  await putSlide(
    { html: originalHtml, canvasOverrides: originalOverrides, force: true },
    { "X-OC-Source": "canvas" }
  );

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error("Round-trip script crashed:", err);
  process.exit(2);
});
