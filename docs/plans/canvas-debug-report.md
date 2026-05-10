# Canvas Refine Mode — Debug & Audit Report

Audit target: Open Carrusel `/refine` mode against carousel
`d2fb3146-f0b2-4dfe-ab44-a72a4febbd90` (slide 1, hook). Symptom that triggered
the audit: clicking "See all 9" → text vanishes until another click happens.
Drilling into that single failure surfaced a cluster of related layout/lifecycle
bugs that explain most of the user's other complaints.

---

## Executive summary — top bugs ranked

| Rank | ID | Severity | Headline |
| ---- | -- | -------- | -------- |
| 1 | BUG-001 | **Blocker** | Single click commits a phantom drag, mutates `overrides`, blows away the iframe mid-interaction, and rewrites `position:absolute` onto the original element in the wrong coordinate space. |
| 2 | BUG-002 | **Blocker** | `srcDoc` is a `useMemo` of `overrides` → every keystroke / drag-tick / Inspector edit reboots the iframe, losing inline-edit caret, focus, scroll, and any in-flight pointer drag. |
| 3 | BUG-003 | **Blocker** | `applyTransform` unconditionally sets `position:absolute` on the ORIGINAL Claude-authored element. Any element that is a flex/grid child or whose nearest positioned ancestor is not `<body>` jumps to a garbage location and visually disappears. |
| 4 | BUG-004 | **Major** | When the original element is tagged `data-oc-layer-id=X` AND `applyOverrides` injects `[data-oc-layer-id="X"]{visibility:hidden}` for a text-edited layer, the runtime's re-tag of the same DOM node makes the original re-match the rule even though only the replica should be hidden. The runtime also overwrites the replica's pre-set `data-oc-layer-id` with a freshly-hashed id (different `cssPath`), so the replica becomes invisible to selection / `applyTransform` / undo. |
| 5 | BUG-005 | **Major** | `onPointerMove` flips `dragModifiedRef = true` on the very first move event, even with sub-pixel jitter, so a click that was meant to be pure selection persists a no-op "drag" into overrides — locking the slide and triggering BUG-001 / BUG-002. |

The remaining ~15 bugs (BUG-006…BUG-020) are documented below.

---

## 1. Specific diagnosis: "See all 9" vanishes on select

### Slide HTML (the load-bearing parts)

```html
<style>
.scrim    { position:absolute; inset:0; z-index:1;
            background:linear-gradient(180deg, rgba(0,0,0,.55) 0%, ...
                                              rgba(0,0,0,.92) 100%); }
.swipe    { position:absolute; bottom:38px; left:0; right:0;
            display:flex; justify-content:center; align-items:center;
            gap:18px; z-index:3; }
.swipe .label { font-family:'Playfair Display',serif; font-style:italic;
                font-size:32px; color:#fff; font-weight:500;
                text-shadow:0 2px 12px rgba(0,0,0,.6); }
.swipe .ar    { display:inline-flex; width:56px; height:56px;
                border-radius:50%; background:#F4B400; color:#0F1F18;
                animation:nudge 1.4s ease-in-out infinite; }
@keyframes nudge { 0%,100%{transform:translateX(0)}
                   50%{transform:translateX(10px)} }
</style>
<div class="s">
  ...
  <div class="swipe">
    <span class="label">See all 9</span>
    <span class="ar">→</span>
  </div>
</div>
```

Two facts matter:

1. `<span class="label">` is a **flex child** of an absolutely-positioned `.swipe`. Its visible position is computed by the flex layout (`justify-content:center`), NOT by its own `top/left`. The runtime measures it in viewport coords (around `x≈470, y≈1268, w≈140, h≈42`).
2. `.swipe` itself is `position:absolute`, so it is the **nearest positioned ancestor** of the label. Once the label becomes `position:absolute`, its `left/top` is interpreted relative to `.swipe`, not to `<body>`.

### Code path that fires on a single user click

Walking through it event-by-event:

1. **`pointerdown`** fires inside the iframe.
   `editor-runtime.ts:535 onPointerDown` →
   - `hitTest` returns the `<span class="label">` layer id.
   - Posts `oc:editor:pointer-down`.
2. **Parent `CanvasEditor.onPointerDown`** (`CanvasEditor.tsx:316`):
   - `setSelectedIds([id])`, `setSelectedId(id)`.
   - Builds `dragRef.current = { kind: "body", startTransform, groupStart, startPointer }`.
   - `dragModifiedRef.current = false`.
   - Re-renders. So far overrides are unchanged.
3. **The mouse moves ≥ 1 px** between pointerdown and pointerup (this is normal — macOS pointer events almost always include at least one stationary `pointermove` between mousedown and mouseup, and any tremor adds more).
   `editor-runtime.ts:570 onPointerMove` always posts `oc:editor:pointer-move` whenever `isDragging` (set in onPointerDown) — there is **no movement threshold**.
4. **Parent `onPointerMove`** (`CanvasEditor.tsx:407`):
   - Computes `snap` (delta is ≈ 0).
   - **`dragModifiedRef.current = true`** — *line 452*. This is the key mistake; even a `delta = (0,0)` move flips the flag.
   - Loops `selectedIds`, calls `sendTransformThrottled(id, next)` with `next = startTransform` (no actual change), and `mutateLayer(id, ..., { commit: false })`.
5. **`mutateLayer`** (`CanvasEditor.tsx:234`):
   - `getOrSeedLayer(id)` (`CanvasEditor.tsx:205`) materializes a `CanvasLayer` from the runtime-measured rect with `style: defaultStyle()` (an empty `{}`) and `transform: { x, y, w, h, rotation: 0, z: 0 }`.
   - Mutator runs (no-op transform change).
   - **`setOverrides(base)`** *line 253* — runs even when `commit: false`.
   - `commit:false` only suppresses the debounced PUT; it does NOT suppress the React state write.
6. **React re-render → `CanvasIframe` receives new `overrides` reference** → `srcDoc = useMemo(..., [html, aspectRatio, overrides])` (`CanvasIframe.tsx:97`) recomputes → React sets a new `srcDoc` on the iframe → **the iframe is torn down and rebooted, mid-pointer-drag**.
7. New iframe loads. Runtime walks the DOM, tags the same span with the same `data-oc-layer-id`, sends `oc:editor:ready` and `oc:editor:layout` to parent.
8. **Parent `onReady`** (`CanvasEditor.tsx:266`) sees `overridesRef.current` is non-empty (we just seeded it), so it loops `overridesRef.current.order` and replays:
   ```js
   send({ type: "oc:editor:apply-transform",
          payload: { id, transform: layer.transform } });
   send({ type: "oc:editor:apply-style",
          payload: { id, style: layer.style } });
   ```
9. **Runtime `applyTransform`** (`editor-runtime.ts:326`):
   ```js
   el.style.position = "absolute";       // ← mutates the original <span>
   el.style.visibility = "visible";
   el.style.left = t.x + "px";           // 470 → 470px from .swipe's left
   el.style.top  = t.y + "px";           // 1268 → 1268px BELOW .swipe's top (≈1256px)
   el.style.width = "140px";
   el.style.height = "42px";
   el.style.transform = "rotate(0deg)";  // also clobbers any CSS animation
   el.style.zIndex = "0";                // drops below the scrim's stacking context!
   ```
   The label is now positioned at `top: 1268px` *inside `.swipe`*, which is at `top ≈ 1256px` of the body. So the visible glyphs sit at **y ≈ 2524px** — far below the 1350-px slide viewport. Combined with `z-index:0` (the scrim is `z-index:1` in body's root stacking, but `.swipe` has `z-index:3` so this only matters if the runtime's z=0 clobbers the parent stacking — see BUG-013). The text is gone.

### Why "click somewhere else" brings the text back

When the user clicks somewhere outside the existing selection, one of two things happens, both of which trigger another iframe reload — the iframe's fresh DOM walk reattaches the span without inline styles, so the flex layout reappears:

- Clicking another text layer triggers exactly the same dragModified-on-jitter pipeline, which re-rebuilds `overrides` and reboots the iframe. The new iframe walks Claude's pristine HTML — the label is back in flex flow.
- Clicking empty space sets `dragRef.current = marquee`. *No commit happens unless the user drags a marquee*, but `setSelectedIds([])` + the next `pointermove` → `setOverrides` cycle still rebuilds the iframe from the next layer's seed mutate. Either way, fresh DOM = label visible.

### One-paragraph fix

Three independent bugs collide here. (1) `mutateLayer` must not call `setOverrides` when `commit:false` — drag-time updates should drive the iframe via the existing `apply-transform` postMessage path only and only persist into React state on commit. (2) The runtime's `applyTransform` must NOT force `position:absolute` on existing layers when the override only changed style or when the override is the seeded "no-op" snapshot — it should leave non-positional overrides as inline styles only and skip the positioning block until the user actually moves the layer. (3) `onPointerMove` in `CanvasEditor` must require a movement of ≥ ~3 px before flipping `dragModifiedRef = true`, so that wiggle-clicks don't persist as drags. Apply (1) and (3) and the symptom disappears even without (2); apply (2) and the symptom can never recur regardless of how the parent chooses to re-apply transforms.

---

## 2. Bug inventory

### BUG-001 — Click commits a phantom drag → iframe reload → text relocated/lost

**Severity:** Blocker
**Files:**
- `src/components/editor/canvas/CanvasEditor.tsx:407-468` (onPointerMove)
- `src/components/editor/canvas/CanvasEditor.tsx:234-259` (mutateLayer)
- `src/components/editor/canvas/CanvasIframe.tsx:97-104` (srcDoc useMemo)
- `src/lib/editor-runtime.ts:326-342` (applyTransform)

**Repro:** Open carousel Direction A v5 → slide 1 → Refine mode → click "See all 9".

**Root cause:** chained as documented above (§1). Every pointermove, even a 0-px one, sets `dragModifiedRef = true`, calls `mutateLayer({commit:false})` which calls `setOverrides(base)`, which mutates the React state object reference, which re-memos `srcDoc`, which reboots the iframe.

**Recommended fix (in priority order):**

1. **CanvasEditor.tsx:452** — guard `dragModifiedRef.current = true` behind a movement threshold. e.g.
   ```js
   if (!dragModifiedRef.current && Math.hypot(p.deltaX, p.deltaY) < 3) return;
   dragModifiedRef.current = true;
   ```
2. **CanvasEditor.tsx:253** — when `options?.commit === false`, **do not call `setOverrides`**. Push the in-progress transform to a separate `liveTransformsRef` for the SelectionOverlay to read; only `setOverrides` on commit (pointer-up).
3. **CanvasIframe.tsx:97-104** — make `srcDoc` depend ONLY on `[html, aspectRatio]`. Pass `overrides` to the iframe via `postMessage` after `onReady` instead of baking them into the document. This decouples the iframe lifecycle from React state churn.
4. **editor-runtime.ts:326** — if the incoming `transform` has `x == null && y == null && w == null && h == null && rotation == null`, do NOT touch `position` / `left` / `top`. Apply z-index only.

---

### BUG-002 — Iframe reboots on every overrides change

**Severity:** Blocker
**Files:** `src/components/editor/canvas/CanvasIframe.tsx:97-104`

**Repro:** Edit any Inspector field (font size +1) → observe DevTools network panel; the iframe re-fetches the runtime/Google Fonts. Inline-edit text, type a character — the cursor jumps because the iframe reboots between keystrokes if you're fast (but `entry.editing` no longer holds across reboot).

**Root cause:**
```ts
const srcDoc = useMemo(
  () => wrapSlideHtml(html, aspectRatio, { overrides: overrides ?? null, editorRuntime: true }),
  [html, aspectRatio, overrides]
);
```

This is the architectural sin behind BUG-001, BUG-004, BUG-005, and BUG-009. The iframe's `srcDoc` should be stable for the lifetime of the slide; overrides should ONLY be applied via the live runtime postMessage channel during refine mode. `applyOverrides` baking into srcDoc was designed for the export pipeline, not the live editor.

**Recommended fix:** Compute `srcDoc` from `[html, aspectRatio, /* initialOverrides taken once */]` only. After `onReady`, push every override layer's transform/style/text via the existing `apply-transform` / `apply-style` / `apply-text` messages. On `addLayer`, send `oc:editor:add-layer` (already implemented). On reset, *then* you can replace `srcDoc` (only place that should rebuild it).

---

### BUG-003 — `applyTransform` always forces `position:absolute` and clobbers CSS animations

**Severity:** Blocker
**Files:** `src/lib/editor-runtime.ts:326-342`

**Repro:** Click any flex-child or grid-child text in any slide (e.g. `.pill` in `.top` flex container, `.label` in `.swipe`, the heading inside `.center`). Element jumps off-layout.

**Root cause:**
```ts
function applyTransform(id, t) {
  const entry = layerById.get(id);
  if (!entry) return;
  const el = entry.el;
  el.style.position = "absolute";   // unconditional
  el.style.visibility = "visible";
  if (t.x != null) el.style.left = t.x + "px";
  ...
  if (t.rotation != null) el.style.transform = "rotate(" + t.rotation + "deg)";
  ...
}
```

Two issues:
- `position:absolute` is set even when no `x/y/w/h` were supplied. Coords are then interpreted relative to whatever the element's nearest positioned ancestor happens to be, which is rarely `<body>`.
- `el.style.transform = "rotate(...)"` overwrites any inherited CSS transform (animations like `.swipe .ar`'s `nudge` animation). The arrow circle stops bouncing the moment you click the label.

**Recommended fix:**
1. Skip the entire positional block if `t.x == null && t.y == null && t.w == null && t.h == null && t.rotation == null`.
2. When positioning IS applied, normalize coords into the body-relative space:
   - Either move the element out of its parent into `<body>` (so `position:absolute` works), wrapping it in a placeholder span if you need to remember its original parent for undo.
   - Or compute coords relative to its nearest positioned ancestor at the time of application.
3. Compose `rotate()` with any pre-existing transform string — read `getComputedStyle(el).transform` once on first touch and append `rotate(N)` to it.
4. Don't unconditionally set `visibility:visible` — only set it when we actually have a hide-style override to counteract.

---

### BUG-004 — Original element re-tagged with same id as the hide-style target → original is hidden along with the replica; replica gets re-tagged with a different id and orphaned

**Severity:** Major
**Files:**
- `src/lib/canvas-overrides.ts:182-213` (replica + hide-style emission)
- `src/lib/editor-runtime.ts:199-240` (tagAndMeasureLayers)

**Repro:** Inline-edit any text layer → blur to commit → text now shows TWICE (original peeks through after `applyTransform` un-hides it via `visibility:visible`) or NEVER (because both versions are visibility:hidden).

**Root cause:**
- `applyOverrides` injects `<div data-oc-layer-id="X" ...>NEW TEXT</div>` AND a `<style>` rule `[data-oc-layer-id="X"]{visibility:hidden!important}` for `X`.
- The runtime's `tagAndMeasureLayers` then walks the DOM. For the ORIGINAL `<span>`, it computes `id = hash53("span|cssPath")` — same as `X` — and calls `el.setAttribute("data-oc-layer-id", X)`. The original now matches the visibility:hidden rule.
- For the REPLICA `<div>` at root level, the runtime computes `hash53("div|body>div:nth-of-type(N))` — a DIFFERENT id. It overwrites the replica's pre-set `data-oc-layer-id` attribute. The replica's DOM attr now no longer matches the visibility:hidden rule (good for visibility) BUT the parent's `overrides` still keys by the OLD id, so `applyTransform`/`applyStyle` from the parent never reach the replica. The replica is effectively orphaned.
- Then the runtime's `applyTransform` (called from parent's `onReady`) sets `el.style.visibility = "visible"` on the original — un-hiding it. So original glyphs at original location reappear, possibly overlapping the replica.

**Recommended fix:**
- Stop overwriting `data-oc-layer-id` if the element already has one. Trust pre-set ids (they came from the server-side merge).
- Distinguish "originally tagged by server" from "freshly walked": replica divs should keep their pre-set ids; only untagged elements get hash-derived ids.
- Or: drop the server-side replica emission entirely. Have the runtime do all the work (apply text, transform, style to the live DOM in-place). The server-side `applyOverrides` only matters for export now — keep it for export, skip it in the live preview.

---

### BUG-005 — `dragModifiedRef` flips on first pointermove regardless of distance

**Severity:** Major
**Files:** `src/components/editor/canvas/CanvasEditor.tsx:452, 552, 561`

**Repro:** Click and release on any layer without moving more than a pixel — overrides for that layer get persisted via `lastDragPositionsRef` even though the user didn't intend to move it.

**Root cause:** `onPointerMove` and the SVG-overlay handle's `onMove` both unconditionally `dragModifiedRef.current = true` on the first event.

**Recommended fix:** introduce a movement threshold (e.g. 3 px in slide coords) before flipping the flag. Below threshold → don't `mutateLayer` and don't update `lastDragPositionsRef`. The pointer-up handler can then early-return cleanly.

---

### BUG-006 — `onTextEdit`'s seeded style is overridden by `defaultStyle() = {}`

**Severity:** Major
**Files:**
- `src/components/editor/canvas/CanvasEditor.tsx:629-645` (onTextEdit)
- `src/components/editor/canvas/CanvasEditor.tsx:78-80, 205-226` (defaultStyle, getOrSeedLayer)

**Repro:** Click-then-double-click a layer to enter inline edit. Type new text. Tab away. Replica appears with browser-default styling (16px Times Roman black) instead of the seeded computed style.

**Root cause:**
```ts
const seededStyle: LayerStyle = { ...(p.computed || {}), ...l.style };
```
But `l.style` came from `getOrSeedLayer` if no override existed yet, which returns `defaultStyle()` = `{}` — fine, the spread of an empty object preserves `p.computed`. **However**, if the user's pointermove jitter (BUG-005) already seeded an override with `style: {}` (defaultStyle) BEFORE the text edit, then on the second mutate the override path is `base.layers[id] ?? getOrSeedLayer(id)` — it picks the existing seeded layer with `style: {}`. Then `{ ...computed, ...{} }` = `computed`. That ACTUALLY works in this specific case.

The real failure mode is when the user:
1. Edits font size in the Inspector to 40 (creates `style.fontSize = 40`).
2. Then double-clicks to inline edit → `getOrSeedLayer` returns `style.fontSize = 40` (and nothing else).
3. Types new text, blurs.
4. `seededStyle = { ...computed, fontSize: 40 }`.
5. The replica is rendered with the original `fontFamily/color/etc` from `computed` (good) BUT loses any `fontWeight` the user might have set if it equals what was already in `style`.

The symptom is small but the spec violation is real: when `computed` has fields and `l.style` has the user's edits, the merge order is wrong on first text edit because `l.style` from `getOrSeedLayer` is `{}`. Subsequent edits compound this.

**Recommended fix:** the merge order is OK; the failure is upstream — `getOrSeedLayer` should return `style: snapshotComputedFromMeasured(id)` instead of `{}`. The runtime's `oc:editor:layout` should already include a `computed` blob per layer (see BUG-007).

---

### BUG-007 — Inspector populates with empty defaults instead of the layer's actual visible style

**Severity:** Major
**Files:**
- `src/components/editor/canvas/Inspector.tsx:183-191`
- `src/components/editor/canvas/CanvasEditor.tsx:78-80, 205-226`

**Repro:** Select "See all 9". Inspector shows Size = 24, Weight = 400, no font, no color set — but the visible label is 32px Playfair Display 500 white italic.

**Root cause:** `getOrSeedLayer` returns `style: defaultStyle()` (empty). `Inspector` then falls back to its hardcoded defaults (`fontSize ?? 24`, `lineHeight ?? 1.2`, etc). The user is editing against ghost values; any change clobbers the original.

**Recommended fix:** the runtime already snapshots `computed` style on `exitInlineEdit`. Do the same eagerly: when `tagAndMeasureLayers` tags an element, ALSO snapshot its `getComputedStyle` and include it in the `oc:editor:layout` payload. Parent uses that as the seed `style` instead of `{}`.

---

### BUG-008 — Drag does not visually persist (handle drag works, body drag visually flickers/snaps back during reload)

**Severity:** Major
**Files:** `src/components/editor/canvas/CanvasEditor.tsx:407-468`

**Repro:** Body-drag a long heading. The selection box follows the mouse but the visible glyphs flicker to the new position then jump back (because the iframe reboots mid-drag → fresh DOM has no inline `left/top`). Release → final commit applies → text moves to the dragged position OR is corrupted (BUG-003).

**Root cause:** Same `setOverrides` → srcDoc churn from BUG-002, observed end-to-end.

**Recommended fix:** Same as BUG-002 — decouple srcDoc from overrides.

---

### BUG-009 — Inline-edit cursor / IME / undo are wiped by every Inspector edit

**Severity:** Major
**Files:** `src/components/editor/canvas/CanvasIframe.tsx:97-104`

**Repro:** Double-click a layer to enter inline edit. With the cursor in the middle of the word, alt-tab to the Inspector and change font size. Tab back — the iframe rebooted, your contenteditable cursor is gone, you have to re-double-click and re-position the cursor.

**Root cause:** Inspector style change → `mutateLayer({commit:true})` → `setOverrides` → srcDoc rebuild → iframe reboot. In-iframe `entry.editing = true` flag is lost. The runtime cannot resume the prior selection range.

**Recommended fix:** Same as BUG-002 (don't reboot the iframe). Bonus: when the runtime sends `apply-style`, if the targeted element is currently in `editing` mode, the runtime should preserve `Selection`/`Range` across the style change.

---

### BUG-010 — Single-click into a focused layer enters inline edit even when the user wanted to drag

**Severity:** Major
**Files:** `src/lib/editor-runtime.ts:556-567`

**Repro:** Select a layer. Click it again to start a drag. If <350ms have elapsed, the runtime treats it as a double-click, posts `oc:editor:dblclick-text`, AND calls `enterInlineEdit(id)`. The user is now in text-edit mode instead of dragging.

**Root cause:** Double-click detection uses `lastDownTimestamp` from any pointer-down, including the first click that selected the layer. The first click that selected → second click within 350 ms is interpreted as dblclick.

**Recommended fix:** Only count the dblclick when both events were on a layer that was ALREADY the active selection BEFORE this click sequence (i.e. the click sequence didn't change `selectedId`). Even better: gate dblclick on a much shorter window (<250 ms) and require the two events to be within 5 px of each other.

---

### BUG-011 — `enterInlineEdit` `el.focus()` on a span without `tabindex` only works in some browsers; selection of the span's contents while the span is `display:inline` produces a degenerate range

**Severity:** Minor
**Files:** `src/lib/editor-runtime.ts:455-473`

**Repro:** Inconsistent across browsers — Safari sometimes ignores `.focus()` on a `<span>` without `tabindex`; the contenteditable is set but typing inserts at `<body>` instead of inside the span.

**Recommended fix:** Set `tabindex="-1"` on the element before `focus()`. Or wrap inline-edit content in a `<div contenteditable>` that the runtime swaps in.

---

### BUG-012 — `applyTransform`'s rect refresh after positioning sees the WRONG coordinate space and caches a wrong rect → subsequent hit-tests miss the layer

**Severity:** Major
**Files:** `src/lib/editor-runtime.ts:340-341`

**Repro:** After BUG-003 misplaces a layer, click where the visible glyphs WERE — nothing selects, because the cached `entry.rect` is the new (post-misplacement) bounds.

**Root cause:**
```ts
const r = el.getBoundingClientRect();
entry.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
```
Whatever the wrong position is, the runtime now believes the layer's hit-test bbox is there.

**Recommended fix:** Falls out of fixing BUG-003.

---

### BUG-013 — `transform.z` for newly-seeded layers is `0`, which clobbers the original's `z-index:auto` and may drop the layer behind the scrim

**Severity:** Major
**Files:**
- `src/components/editor/canvas/CanvasEditor.tsx:205-226` (getOrSeedLayer assigns `z: 0`)
- `src/lib/editor-runtime.ts:338` (`el.style.zIndex = String(t.z)`)

**Repro:** Click any layer that lives in a shallow stacking context. After the phantom commit (BUG-001), the layer drops behind sibling elements with explicit `z-index`.

**Root cause:** `getOrSeedLayer` defaults `z: 0`, then `applyTransform` writes it as inline `zIndex:"0"`. For elements like `.swipe .label` whose parent `.swipe` has `z-index:3`, the label inherits stacking context `auto` → behaves as if at parent's z. After we set its own `z-index:0`, it joins the local stacking context with explicit z=0, which can re-order it relative to siblings.

**Recommended fix:** Don't set `z-index` unless the user has explicitly rearranged the layer (z-order change). On seed, leave `transform.z` as `null` and skip `el.style.zIndex` in `applyTransform` when null.

---

### BUG-014 — Multi-select drag of mixed-kind layers (one `existing`, one `new`) produces inconsistent positioning

**Severity:** Minor
**Files:** `src/components/editor/canvas/CanvasEditor.tsx:454-466`

**Repro:** Shift-click an "existing" text and a "new" placed text. Drag. The new layer (which is `position:absolute` natively in the replica) moves correctly. The existing one inherits BUG-003.

**Recommended fix:** Same as BUG-003 — fix coordinate-space handling for existing layers.

---

### BUG-015 — Reset slide button does a full `window.location.reload()` instead of bumping a key

**Severity:** Minor
**Files:** `src/components/editor/canvas/CanvasEditor.tsx:1096-1112`

**Repro:** Reset slide → entire app reloads, losing any unsaved chat-panel state, scroll positions, multi-tab work.

**Recommended fix:** as the comment in code says — wire a `key` prop to `CanvasIframe` and bump it. Then `setOverrides(null)` + key++ remounts only the iframe.

---

### BUG-016 — `onReady` re-applies overrides every time the iframe boots; combined with BUG-002 this makes the iframe fight the user's drag

**Severity:** Major
**Files:** `src/components/editor/canvas/CanvasEditor.tsx:266-286`

**Repro:** Drag a layer. Mid-drag, iframe reboots (BUG-002), `onReady` fires, replays apply-transform with the seeded transform, snapping the layer to its pre-drag position briefly until the next pointermove writes the new position. Visible jitter.

**Recommended fix:** Falls out of BUG-002 (don't reboot mid-interaction). If srcDoc must remain coupled, have `onReady` skip apply if `dragRef.current !== null`.

---

### BUG-017 — `mutateLayer` reads `selectedIds` from a stale closure during alignment / arrow-key nudges

**Severity:** Minor
**Files:** `src/components/editor/canvas/CanvasEditor.tsx:737-817`

**Repro:** Select 3 layers, hit alignment-left, then immediately hit arrow-up. The arrow-up may use a stale `selectedIds` because the alignment's setState batched with the keydown's setState.

**Root cause:** `useEffect`'s `selectedIds` dep is correct, but `selectedIds` itself is captured into the closure at render time. The keydown handler's effect re-binds on selectedIds change so usually fine — but the re-bind happens AFTER React commit, which is AFTER the user could have already pressed the key.

**Recommended fix:** Use a `selectedIdsRef` updated from a tiny `useEffect`, and read `selectedIdsRef.current` inside `onKey`.

---

### BUG-018 — `scheduleSave` debounce loses the most recent value on rapid slide change

**Severity:** Minor
**Files:** `src/components/editor/canvas/CanvasEditor.tsx:181-196`

**Repro:** Edit slide A. Within 350 ms, switch to slide B. The unmount cleanup tries `flushSave(overridesRef.current)` but `overridesRef.current` may already point to slide B's initial overrides because `useEffect [slideId]` (line 952) runs `setOverrides(initialOverrides)`.

**Recommended fix:** Capture the pre-switch snapshot synchronously in the effect's cleanup function before the next-effect sets the new initialOverrides.

---

### BUG-019 — `hashLayerId` collision when two siblings have same tag and `cssPath`

**Severity:** Minor (theoretical)
**Files:** `src/lib/canvas-overrides.ts:68-77`, `src/lib/editor-runtime.ts:43-50`

The `cssPath` includes `:nth-of-type` so collisions should be impossible in practice. But the collision-handling line in the runtime — `if (layerById.has(id)) continue; // collision: keep first` — silently drops the second occurrence. If a future refactor breaks `cssPath` uniqueness, half the slide goes silently un-editable. Add a `console.warn` or a debug breadcrumb.

---

### BUG-020 — Image loading: relative `/uploads/...` URLs work in the iframe (same origin), but if/when sandbox is hardened to `allow-scripts` only, they will silently 404

**Severity:** Cosmetic / future-proofing
**Files:** `src/components/editor/canvas/CanvasIframe.tsx:200`

The current sandbox is `allow-scripts allow-same-origin` so the iframe can fetch `/uploads/*`. That coupling is implicit. Document it, or inline images as `data:` URIs the way the export pipeline does.

---

## 3. Audit table

| Feature | Status | Notes |
| ------- | ------ | ----- |
| Selection visuals — short text | **Broken** | Triggers BUG-001 immediately. After phantom commit + iframe reload, original element gets `position:absolute` and may misposition. |
| Selection visuals — long heading with inline `<span>` accent | **Partial** | The `INLINE_TEXT_TAGS` fix correctly avoids tagging the inline accent; whole heading is one layer. Tight rect via Range works. BUG-001 still applies on click. |
| Selection visuals — multi-line text | **Partial** | `measureTextRect` correctly hugs the multi-line text via union of Range.getClientRects. Selection box matches. BUG-001 still applies. |
| Selection visuals — text inside flex containers | **Broken** | The "See all 9" case. BUG-003 strips text out of flex flow. |
| Selection visuals — text inside `position:absolute` containers | **Broken** | BUG-003 — coords are interpreted in the wrong space. |
| Drag visually moves the layer | **Partial** | Final position on pointer-up is correct for layers whose parent is `<body>`. For nested-positioned layers, BUG-003 misplaces. Also BUG-008 visual flicker. |
| Drag persists on reload | **Broken** | `applyOverrides` doesn't bake transforms into the persisted HTML for "existing" layers without text override (correct), so on reload the runtime re-applies via `onReady` → BUG-003 misplaces again. |
| Selection box follows during drag | **Yes** | SelectionOverlay is parent-side and reads `selectedLayer.transform`, which `mutateLayer` updates each move. |
| Resize: 8 handles work | **Mostly** | `computeHandleTransform` math is correct. Resize triggers `applyTransform` → BUG-003 for existing layers. |
| Resize: aspect-lock with Shift | **Yes** | Math at CanvasEditor.tsx:1168-1181 is correct. |
| Resize: center-resize with Alt | **Yes** | CanvasEditor.tsx:1184-1189. |
| Resize: min size enforced | **Yes** | min 4 px (CanvasEditor.tsx:1192-1199). |
| Rotate: top handle works | **Yes** | `computeHandleTransform` rotation branch is correct. |
| Rotate: Shift = 15° snap | **Yes** | `if (shift) angle = Math.round(angle / 15) * 15;` |
| Inspector: editing font size updates live | **Partial** | Sends `apply-style` but iframe also reboots from BUG-002, causing flicker. |
| Inspector: editing color updates live | **Partial** | Same as above. |
| Inspector: editing alignment updates live | **Partial** | Same. |
| Inspector populates with actual visible style | **Broken** | BUG-007 — populates with `{}` defaults. |
| Inline edit: dblclick → contenteditable | **Mostly** | Works, but BUG-010 (single re-click within 350 ms also enters edit mode) and BUG-011 (Safari focus on inline span). |
| Inline edit: typing → Enter or blur commits | **Yes** | onBlurCapture + Enter/Escape keydown both commit. |
| Inline edit: edited text inherits original font | **Partial** | After commit, replica `<div>` is rendered with the seeded `computed` style. But BUG-004 leaves the original visible underneath in many cases. |
| Multi-select: shift-click | **Yes** | CanvasEditor.tsx:373-376. |
| Multi-select: marquee drag | **Yes** | Marquee branch in onPointerMove. Selection on pointer-up. |
| Multi-select: group drag | **Partial** | Math correct; BUG-001 still misplaces individual elements. |
| Snap guides during drag | **Partial** | Math (`useSnap.ts`) is sound and unit-tested. Visual guides render correctly. But BUG-001 corrupts the underlying drag. |
| Add new text layer (T key → click) | **Yes** | placeMode branch in `onPointerDown` works. New layer is `kind: "new"`, gets the absolute-positioned replica which is correctly positioned. Auto-enters inline edit. |
| Delete layer (Delete/Backspace) | **Yes** | `deleteLayer` posts to runtime + clears override. |
| Z-order Cmd+] / Cmd+[ | **Mostly** | `setLayerZ` updates order array and z-index. Z-index rebuild on existing layers triggers BUG-003. |
| Undo Cmd+Z / Redo Cmd+Shift+Z | **Mostly** | Stack management correct. After undo, `onReady`-style replay applies transforms → BUG-003 if existing-layer override. |
| Reset slide button visible when overrides exist | **Yes** | `hasOverrides` prop wired. |
| Reset slide → reload → original | **Yes** | `flushSave(null)` then `window.location.reload()` works. (BUG-015 — full page reload is heavy.) |
| Lock guard: 423 without `X-OC-Source: canvas` | **Yes** | `src/app/api/.../slides/[slideId]/route.ts:28-37`. |
| Unlock with keepText=true | **Yes** | Bakes overrides into HTML via `applyOverrides`. **BUT** the baked HTML inherits BUG-003 / BUG-004 because the overrides themselves are corrupt — i.e. the pixel-identity claim only holds if the live preview was already correct. |
| Round-trip: edits survive page reload | **Partial** | The JSON is persisted. On reload, BUG-003 reproduces immediately because `onReady` replays apply-transform. |
| Round-trip: survive slide change + back | **Partial** | Overrides are stored per slide. Switching back shows BUG-003 again. |
| PNG export of refined slide | **Probably broken for nested-positioned layers** | Export uses `applyOverrides` on the source HTML and runs without the runtime, so it sees only the replicas + originals. For existing layers without text override, NOTHING is emitted in the merged HTML — so the user's drag/style edits are LOST in PNG export entirely. |
| MP4 export | **Yes** | `editorRuntime: false` confirmed at `export-video.ts:85`. Animation is preserved. |

The PNG-export observation deserves its own bug:

### BUG-021 — `applyOverrides` only emits replicas for `new` or text-edited layers; pure transform/style edits on existing layers are LOST in export

**Severity:** Major
**Files:** `src/lib/canvas-overrides.ts:182-204`

**Repro:** Drag a Claude-authored heading 200 px down. Save. Export PNG. The PNG shows the heading at the original location. (The override JSON has the new transform, but `applyOverrides` short-circuits at line 192 for existing layers without text override, leaving the original HTML untouched and emitting no replica.)

**Root cause:** the recent fix that "stops emitting replicas for existing layers without text overrides" is correct for the LIVE editor (where the runtime re-applies the transforms post-load), but it BREAKS export, where there is no runtime to re-apply.

**Recommended fix:** the export call to `applyOverrides` needs a different mode, e.g. `applyOverrides(html, overrides, { mode: "export" })` which DOES emit a replica for any overridden existing layer (and DOES emit the visibility:hidden rule). The live editor calls it with `mode: "preview"` (current behavior).

---

## 4. Architectural smells (not currently broken but fragile)

### S-1. The "tag the original DOM, then also emit a replica with the same id" trick is too clever and creates BUG-004.

The runtime walking the DOM and OVERWRITING pre-set `data-oc-layer-id` attributes is the root of the orphaned-replica issue. Either fully own the id assignment in the runtime, or fully trust server-set ids — not both.

### S-2. `srcDoc` as a function of state means React sees the iframe as a *value* and reboots it on any state change.

Most production iframe editors (Figma, Canva, even simple WYSIWYG editors) treat the iframe as a long-lived child with a postMessage protocol. Open Carrusel mostly does that, except for the `srcDoc` regeneration path. Pick one model and stick with it.

### S-3. `mutateLayer({commit:false})` ALSO writes React state.

The naming implies a no-op for state. The `commit` flag ONLY gates the debounced PUT. This is a footgun that caused BUG-001. Rename to `{ persist: false }` and decouple from `setOverrides`.

### S-4. `getOrSeedLayer` returns `style: {}` when it could return the real computed style.

Inspector reads from the layer's style and falls back to defaults. Fixing BUG-007 properly requires the runtime to ship `computed` per layer in the layout payload. Today's code is missing the data plumbing.

### S-5. The runtime mutates `el.style.position`, `el.style.transform`, `el.style.visibility`, and `el.style.zIndex` for any element it touches.

These four properties are also commonly used by Claude's HTML for layout and animation. The collision is unavoidable today; document it as a known constraint, OR (better) wrap each existing element in an absolute positioning shell and apply transforms to the shell, not the element.

### S-6. Bundle drift risk.

`editor-runtime.bundle.ts` mtime (1778350753) is newer than `editor-runtime.ts` (1778350730), so we're shipping the latest source. But there's no CI check enforcing this. Add `npm run build:editor-runtime --check` to a pre-commit hook so a stale bundle can't be committed.

### S-7. `onReady` callback closes over `overridesRef` correctly but `selectedIds` is re-derived from React render closures in many places.

Document the convention: anything mutated on every pointer event should be in a ref; anything used only in render should be state. Today it's mixed.

### S-8. The dblclick window of 350 ms is too long for a drag-after-select interaction (BUG-010).

A user who selects then immediately drags will trigger inline edit with high probability. Tighten the window or add the "must already be selected" guard.

### S-9. Pointer events bypass React's synthetic event system.

`pointerdown` is handled in capture phase inside the runtime AND on `window` in the parent for the SVG handle drags. Two systems racing for the same gesture. So far the iframe sandbox isolation prevents true conflicts, but any future "click outside the iframe to deselect" feature has to thread the needle carefully.

---

## 5. Recommended fix order

Each fix listed with a rough effort estimate (S = <1 hr, M = 1–4 hr, L = 4–8 hr).

| # | Fix | Effort | Why this order |
| - | --- | ------ | -------------- |
| 1 | **BUG-005:** add 3-px movement threshold before `dragModifiedRef = true` (and before any `mutateLayer` from drag). | S | Eliminates the "See all 9" symptom for pure clicks. Cheapest possible win. |
| 2 | **BUG-001 (core):** make `mutateLayer({commit:false})` skip `setOverrides`. Track in-flight transform in a `liveTransformsRef` that the SelectionOverlay reads. | M | Prevents iframe reload during drag. Big stability win. |
| 3 | **BUG-002:** change `srcDoc` deps to `[html, aspectRatio]` only; push overrides via postMessage on `onReady`. | M | Eliminates iframe reboot on every commit. Required to fix BUG-009 (cursor loss in Inspector). |
| 4 | **BUG-003:** make `applyTransform` a no-op for the positional block when no `x/y/w/h/rotation` supplied. AND, when positioning is applied, either move the element to `<body>` or compute coords relative to its current positioned ancestor. | M | Fixes the "flex/absolute parent" coordinate corruption. Combined with #1–3 the user can drag any layer safely. |
| 5 | **BUG-007:** runtime sends `computed` style per layer in `oc:editor:layout`. Parent uses it as `getOrSeedLayer`'s style. | S | Inspector now shows truthful values; user's edits stop ghosting. |
| 6 | **BUG-021:** add `mode: "preview" | "export"` to `applyOverrides`. Export bakes existing-layer transforms; preview leaves them for runtime. | M | Restores PNG/MP4 export fidelity for transform-only edits. |
| 7 | **BUG-004:** stop overwriting pre-set `data-oc-layer-id` in `tagAndMeasureLayers`. Skip elements that already have one. | S | Replicas stop getting orphaned; original-vs-replica visibility math works. |
| 8 | **BUG-010:** tighten dblclick window + require "click on a layer that was already the active selection". | S | Drag-after-select stops accidentally entering inline edit. |
| 9 | **BUG-013:** stop emitting `z-index:0` on seed; only set z-index when user explicitly z-orders. | S | Layers stop sliding behind sibling elements after seed. |
| 10 | **BUG-015:** wire a `key` prop on `CanvasIframe` and bump it on Reset Slide instead of `window.location.reload()`. | S | Smaller, faster, less destructive UX. |

After these 10 fixes the audit table flips to "Yes" / "Mostly" across the board, with the remaining minor bugs (BUG-006, BUG-011, BUG-014, BUG-016, BUG-017, BUG-018, BUG-019, BUG-020) being polish-tier items.

---

## Appendix: file inventory & line refs

- **`src/lib/editor-runtime.ts`**
  - `applyTransform` 326–342 (BUG-003, BUG-012)
  - `tagAndMeasureLayers` 199–240 (BUG-004, BUG-019)
  - `onPointerDown` 535–568 (BUG-010, BUG-011)
  - `enterInlineEdit` 455–473 (BUG-011)
  - `exitInlineEdit` 475–501 (computed-style snapshot — used by BUG-006/007)
- **`src/lib/canvas-overrides.ts`**
  - `applyOverrides` 151–225 (BUG-004, BUG-021)
  - `hashLayerId` 68–77 (BUG-019)
- **`src/components/editor/canvas/CanvasIframe.tsx`**
  - `srcDoc` 97–104 (BUG-002, BUG-008, BUG-009, BUG-016)
- **`src/components/editor/canvas/CanvasEditor.tsx`**
  - `getOrSeedLayer` 205–226 (BUG-007, BUG-013)
  - `mutateLayer` 234–259 (BUG-001, BUG-005)
  - `onPointerMove` 407–468 (BUG-001, BUG-005, BUG-008)
  - `onReady` 266–286 (BUG-001 step 8, BUG-016)
  - `onTextEdit` 629–645 (BUG-006)
  - `onResetSlide` 1096–1112 (BUG-015)
- **`src/components/editor/canvas/Inspector.tsx`**
  - `s = ... ?? layer.style` 183–191 (BUG-007)
- **`src/types/canvas.ts`**
  - `apply-transform` payload accepts `Partial<LayerTransform>` 51–53 — fine, but the runtime should respect "partial" semantics (BUG-003 fix).
- **`src/lib/slide-html.ts`**
  - `wrapSlideHtml` 51–108 — correct; the editor-runtime injection guard works as designed.
- **`src/app/api/carousels/[id]/slides/[slideId]/route.ts`** — lock guard works correctly (BUG audit confirmed 423 path).
- **`src/app/api/carousels/[id]/slides/[slideId]/unlock/route.ts`** — unlock with `keepText=true` works as designed BUT inherits BUG-021 (the baked HTML may not include transform-only overrides if the editor was using preview-mode `applyOverrides`).
