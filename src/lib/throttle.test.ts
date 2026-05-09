/**
 * Phase 6 — throttle.ts unit tests.
 *
 * Run: node --test --experimental-strip-types --import ./scripts/test-loader.mjs src/lib/throttle.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { throttle, rafThrottle } from "./throttle.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("throttle: leading-edge call fires immediately", () => {
  let count = 0;
  const fn = throttle(() => count++, 50);
  fn();
  assert.equal(count, 1);
});

test("throttle: bursts within window collapse to one trailing call", async () => {
  let count = 0;
  const args: number[] = [];
  const fn = throttle((n: number) => {
    count++;
    args.push(n);
  }, 30);
  fn(1);
  fn(2);
  fn(3);
  fn(4);
  // Leading fires now (count=1, arg=1). Trailing fires after the window
  // with the most recent args (4).
  assert.equal(count, 1);
  await sleep(60);
  assert.equal(count, 2);
  assert.deepEqual(args, [1, 4]);
});

test("throttle: cancel() drops pending trailing call", async () => {
  let count = 0;
  const fn = throttle(() => count++, 30);
  fn();
  fn();
  fn();
  fn.cancel();
  await sleep(60);
  assert.equal(count, 1);
});

test("throttle: flush() runs pending trailing call synchronously", () => {
  let count = 0;
  const fn = throttle((n: number) => {
    count += n;
  }, 30);
  fn(1);
  fn(5);
  fn.flush();
  // Leading fired with 1, flush ran trailing with 5 → 6.
  assert.equal(count, 6);
});

test("throttle: calls after window fire as new leading edge", async () => {
  let count = 0;
  const fn = throttle(() => count++, 20);
  fn();
  await sleep(40);
  fn();
  assert.equal(count, 2);
});

test("rafThrottle: collapses bursts to one call per frame", async () => {
  let count = 0;
  const args: number[] = [];
  const fn = rafThrottle((n: number) => {
    count++;
    args.push(n);
  });
  fn(1);
  fn(2);
  fn(3);
  // Nothing has fired yet — RAF is async.
  assert.equal(count, 0);
  await sleep(40);
  // Exactly one call with latest args.
  assert.equal(count, 1);
  assert.deepEqual(args, [3]);
});

test("rafThrottle: cancel() prevents pending call", async () => {
  let count = 0;
  const fn = rafThrottle(() => count++);
  fn();
  fn.cancel();
  await sleep(40);
  assert.equal(count, 0);
});

test("rafThrottle: flush() runs pending call synchronously", () => {
  let count = 0;
  const fn = rafThrottle((n: number) => {
    count = n;
  });
  fn(7);
  fn.flush();
  assert.equal(count, 7);
});

test("rafThrottle: subsequent burst after frame fires once more", async () => {
  let count = 0;
  const fn = rafThrottle(() => count++);
  fn();
  await sleep(40);
  fn();
  fn();
  fn();
  await sleep(40);
  assert.equal(count, 2);
});
