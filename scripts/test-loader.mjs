// Minimal loader hook so `node --test` can resolve `@/...` imports the
// way the Next.js bundler does. Used by the canvas-overrides Phase 1 tests
// (and any future plain-Node tests).
//
// Why custom: the project doesn't have a Vitest/Jest install, and Node's
// built-in --experimental-strip-types drops type-only imports cleanly but
// has no idea about TS path aliases.
//
// Usage (Node 22+, modern):
//   node --test --experimental-strip-types --import ./scripts/test-loader.mjs <file>
// Usage (legacy):
//   node --test --experimental-strip-types --loader ./scripts/test-loader.mjs <file>
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as pathResolve, dirname } from "node:path";
import { register } from "node:module";

// Self-register the loader hooks so this file works as `--import` target.
// `register()` is a no-op (idempotent) when invoked from inside the loader
// itself; we only invoke it when this module is being preloaded.
if (!process.env.__OC_TEST_LOADER_REGISTERED__) {
  process.env.__OC_TEST_LOADER_REGISTERED__ = "1";
  register(import.meta.url, pathToFileURL("./"));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = pathResolve(HERE, "..", "src");

import { existsSync } from "node:fs";

function tryAdd(path) {
  for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
    if (existsSync(path + ext)) return path + ext;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = pathResolve(SRC, specifier.slice(2));
    const found = tryAdd(target);
    if (found) {
      return nextResolve(pathToFileURL(found).href, context);
    }
  }
  // Bare relative imports without extension also fail under
  // --experimental-strip-types. We also handle imports that LOOK like they
  // have an extension but actually don't (e.g. `./editor-runtime.bundle`
  // where `.bundle` is part of the basename, not the extension), by retrying
  // with `.ts` appended after the unresolved-as-given path.
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const parentPath = fileURLToPath(context.parentURL);
    const target = pathResolve(dirname(parentPath), specifier);
    if (!/\.[a-z]+$/i.test(specifier)) {
      const found = tryAdd(target);
      if (found) {
        return nextResolve(pathToFileURL(found).href, context);
      }
    } else if (!existsSync(target)) {
      // Has a "fake" extension (e.g. `.bundle`) — try appending `.ts`/`.tsx`.
      const found = tryAdd(target);
      if (found) {
        return nextResolve(pathToFileURL(found).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
