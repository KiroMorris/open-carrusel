/**
 * Phase 6 — Tiny throttling helpers.
 *
 * `throttle(fn, ms)`  — leading-edge throttle with a trailing call so the
 *                       last invocation is never lost. Useful for any
 *                       interval-bounded rate limit (e.g. autosave at 500ms).
 *
 * `rafThrottle(fn)`   — collapses bursts to one call per animation frame
 *                       (~60fps). Ideal for drag/move handlers feeding
 *                       `apply-transform` postMessage so we don't blow up
 *                       the network with per-pixel updates.
 *
 * Both helpers expose `.cancel()` to drop any pending trailing call.
 *
 * No deps; SSR-safe — `requestAnimationFrame` is feature-detected and falls
 * back to `setTimeout(fn, 16)` on the server.
 */

export interface Throttled<F extends (...args: never[]) => unknown> {
  (...args: Parameters<F>): void;
  cancel(): void;
  flush(): void;
}

/**
 * Leading + trailing throttle. The first call fires immediately; subsequent
 * calls within `ms` are coalesced into a single trailing call that fires at
 * the end of the window using the most recent arguments.
 */
export function throttle<F extends (...args: never[]) => unknown>(
  fn: F,
  ms: number
): Throttled<F> {
  let lastCall = 0;
  let pendingArgs: Parameters<F> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function invoke(args: Parameters<F>) {
    lastCall = Date.now();
    pendingArgs = null;
    fn(...args);
  }

  const wrapped = ((...args: Parameters<F>) => {
    const now = Date.now();
    const elapsed = now - lastCall;
    if (elapsed >= ms) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke(args);
    } else {
      pendingArgs = args;
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          if (pendingArgs) invoke(pendingArgs);
        }, ms - elapsed);
      }
    }
  }) as Throttled<F>;

  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
  };

  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingArgs) invoke(pendingArgs);
  };

  return wrapped;
}

/**
 * RAF throttle: at most one call per animation frame. Use for high-frequency
 * pointer/drag handlers where 60fps is the right cadence and the latest
 * arguments win. SSR-safe via setTimeout fallback.
 */
export function rafThrottle<F extends (...args: never[]) => unknown>(
  fn: F
): Throttled<F> {
  let pendingArgs: Parameters<F> | null = null;
  let scheduled = false;
  let frameId: number | null = null;

  const raf =
    typeof requestAnimationFrame !== "undefined"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) =>
          setTimeout(() => cb(Date.now()), 16) as unknown as number;
  const caf =
    typeof cancelAnimationFrame !== "undefined"
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

  function flushFrame() {
    scheduled = false;
    frameId = null;
    if (pendingArgs) {
      const args = pendingArgs;
      pendingArgs = null;
      fn(...args);
    }
  }

  const wrapped = ((...args: Parameters<F>) => {
    pendingArgs = args;
    if (!scheduled) {
      scheduled = true;
      frameId = raf(flushFrame) as number;
    }
  }) as Throttled<F>;

  wrapped.cancel = () => {
    if (frameId !== null) caf(frameId);
    frameId = null;
    scheduled = false;
    pendingArgs = null;
  };

  wrapped.flush = () => {
    if (frameId !== null) caf(frameId);
    frameId = null;
    scheduled = false;
    if (pendingArgs) {
      const args = pendingArgs;
      pendingArgs = null;
      fn(...args);
    }
  };

  return wrapped;
}
