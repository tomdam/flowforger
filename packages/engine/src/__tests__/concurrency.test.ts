import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithConcurrency } from '../concurrency.js';

describe('runWithConcurrency', () => {
  it('should run all items and return results in order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithConcurrency(items, 3, async (item) => {
      return item * 2;
    });

    assert.deepEqual(results, [
      { index: 0, status: 'fulfilled', value: 2 },
      { index: 1, status: 'fulfilled', value: 4 },
      { index: 2, status: 'fulfilled', value: 6 },
      { index: 3, status: 'fulfilled', value: 8 },
      { index: 4, status: 'fulfilled', value: 10 },
    ]);
  });

  it('should respect concurrency limit', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    await runWithConcurrency(items, 3, async (item) => {
      concurrentCount++;
      if (concurrentCount > maxConcurrent) maxConcurrent = concurrentCount;
      await new Promise((r) => setTimeout(r, 20));
      concurrentCount--;
      return item;
    });

    assert.ok(maxConcurrent <= 3, `max concurrent was ${maxConcurrent}, expected <= 3`);
    assert.ok(maxConcurrent >= 2, `max concurrent was ${maxConcurrent}, expected >= 2 (pool should actually parallelize)`);
  });

  it('should stop launching new items after a failure', async () => {
    const launched: number[] = [];
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    const results = await runWithConcurrency(items, 2, async (item) => {
      launched.push(item);
      await new Promise((r) => setTimeout(r, 10));
      if (item === 3) throw new Error('fail on 3');
      return item;
    });

    // Items 1 and 2 should succeed
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'fulfilled');

    // Item 3 should fail
    assert.equal(results[2].status, 'rejected');

    // Some later items should be skipped (not all 10 launched)
    const skipped = results.filter((r) => r.status === 'skipped');
    assert.ok(skipped.length > 0, 'some items should be skipped after failure');

    // In-flight items at time of failure should have completed
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 2, 'in-flight items should complete');
  });

  it('should handle empty input', async () => {
    const results = await runWithConcurrency([], 5, async (item) => item);
    assert.deepEqual(results, []);
  });

  it('should handle concurrency of 1 (sequential)', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const items = [1, 2, 3];

    await runWithConcurrency(items, 1, async (item) => {
      concurrentCount++;
      if (concurrentCount > maxConcurrent) maxConcurrent = concurrentCount;
      await new Promise((r) => setTimeout(r, 10));
      concurrentCount--;
      return item;
    });

    assert.equal(maxConcurrent, 1, 'concurrency 1 should be sequential');
  });

  it('should handle external stop signal', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const stopSignal = { stopped: false };

    const results = await runWithConcurrency(items, 2, async (item) => {
      await new Promise((r) => setTimeout(r, 10));
      if (item === 3) stopSignal.stopped = true;
      return item;
    }, stopSignal);

    const skipped = results.filter((r) => r.status === 'skipped');
    assert.ok(skipped.length > 0, 'items after stop signal should be skipped');
  });
});
