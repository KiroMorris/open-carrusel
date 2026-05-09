/**
 * Phase 3 — hashLayerId parity test.
 *
 * The editor runtime (`editor-runtime.ts`) ships its own copy of the cyrb53
 * hash + normalize pipeline because it can't import from `canvas-overrides.ts`
 * (no bundler inside the iframe). They MUST agree byte-for-byte; otherwise
 * every persisted override key would silently orphan after a render cycle.
 *
 * This test re-evaluates the runtime's `hashLayerId` body in Node and asserts
 * it produces the same id as `canvas-overrides.ts#hashLayerId` for a fixed
 * corpus of inputs.
 *
 * Run: `node --test --experimental-strip-types src/lib/hash-layer-id.parity.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";

import { hashLayerId as parentHash } from "./canvas-overrides.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_TS = resolve(HERE, "editor-runtime.ts");

// Strip types from the runtime source so we can pull `hashLayerId` out and
// run it under Node. The runtime is type-stripper-friendly by construction.
const fullRuntimeJs = stripTypeScriptTypes(readFileSync(RUNTIME_TS, "utf8"), {
  mode: "strip",
});

// Truncate at the boot block: the runtime has top-level `if
// (document.readyState === ...)` which would throw under Node. The hash
// functions live in the first ~50 lines so a substring up to the first DOM
// access is safe.
const cutoffIdx = fullRuntimeJs.indexOf("// --- DOM walking");
const runtimeJs =
  cutoffIdx > 0 ? fullRuntimeJs.slice(0, cutoffIdx) : fullRuntimeJs;

// We don't want to *boot* the runtime (it touches `document` etc. on load),
// just yank out the three hash functions. Use a Function constructor with a
// shim that captures the named functions via `return`.
const runtimeHash = new Function(
  runtimeJs + "\nreturn { hash53, normalizeText, hashLayerId };"
)() as {
  hashLayerId: (tag: string, cssPath: string, text: string) => string;
};

const corpus: Array<[string, string, string]> = [
  ["h1", "body>div>h1:nth-of-type(1)", "Hello World"],
  ["h2", "body>div>section>h2:nth-of-type(2)", "  Subtitle  "],
  ["p", "body>p:nth-of-type(3)", "Some long sentence with more words."],
  ["span", "body>div>p:nth-of-type(1)>span:nth-of-type(2)", "inline"],
  ["div", "body>div:nth-of-type(7)", ""],
  ["strong", "body>div>p>strong:nth-of-type(1)", "BOLD"],
  ["h1", "body>h1:nth-of-type(1)", "MIXED Case Text"],
];

for (const [tag, path, text] of corpus) {
  test(`hashLayerId parity: ${tag} | ${path.slice(0, 20)} | "${text.slice(0, 12)}"`, () => {
    const a = parentHash(tag, path, text);
    const b = runtimeHash.hashLayerId(tag, path, text);
    assert.equal(b, a, `runtime hash diverged from parent hash`);
    assert.ok(a.startsWith("oc-"));
  });
}

test("hashLayerId parity: empty inputs", () => {
  const a = parentHash("", "", "");
  const b = runtimeHash.hashLayerId("", "", "");
  assert.equal(b, a);
});
