export interface PoolResult<T> {
  index: number;
  status: 'fulfilled' | 'rejected' | 'skipped';
  value?: T;
  error?: any;
}

export interface StopSignal {
  stopped: boolean;
}

/**
 * Run an async function over an array of items with a concurrency limit.
 * Matches Power Automate foreach parallel behavior:
 * - On failure: finish in-flight, stop launching new items
 * - Results are returned in original index order
 * - An external StopSignal can also halt new launches (for debug hook 'stop')
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  stopSignal?: StopSignal,
): Promise<PoolResult<R>[]> {
  if (items.length === 0) return [];

  const results: PoolResult<R>[] = items.map((_, i) => ({
    index: i,
    status: 'skipped' as const,
  }));

  let nextIndex = 0;
  let hasFailed = false;
  const active = new Set<Promise<void>>();

  function shouldStop(): boolean {
    return hasFailed || (stopSignal?.stopped ?? false);
  }

  function launchNext(): Promise<void> | null {
    if (nextIndex >= items.length || shouldStop()) return null;

    const i = nextIndex++;
    const item = items[i];

    const p = fn(item, i)
      .then((value) => {
        results[i] = { index: i, status: 'fulfilled', value };
      })
      .catch((error) => {
        results[i] = { index: i, status: 'rejected', error };
        hasFailed = true;
      })
      .finally(() => {
        active.delete(p);
      });

    active.add(p);
    return p;
  }

  // Fill initial pool up to limit
  for (let i = 0; i < limit && i < items.length; i++) {
    launchNext();
  }

  // As each completes, launch next (if not stopped)
  while (active.size > 0) {
    await Promise.race(active);
    // Launch new items to fill freed slots (only if not stopped)
    while (active.size < limit && nextIndex < items.length && !shouldStop()) {
      launchNext();
    }
  }

  return results;
}
