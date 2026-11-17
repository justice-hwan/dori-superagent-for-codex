/** The existing runners' cadence wait, cancellable by their foreground owner. No extra scheduler. */
export function loopWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
