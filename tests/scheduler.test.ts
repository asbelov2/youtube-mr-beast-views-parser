import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { runScheduler } from '../src/scheduler.js';
import type { CollectionResult } from '../src/types.js';

const RESULT: CollectionResult = {
  observedAt: '2026-10-13T12:00:00.000Z', candidates: 1, recorded: 1, skipped: 0,
};

test('runs immediately, never overlaps slow collections, and stops on abort', async () => {
  const abort = new AbortController();
  let running = 0;
  let maxRunning = 0;
  let completions = 0;
  await runScheduler({
    intervalMs: 1, signal: abort.signal,
    collect: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await sleep(5);
      running--;
      return RESULT;
    },
    onResult: () => { completions++; if (completions === 3) abort.abort(); },
    onError: (error) => { throw error; },
  });
  assert.equal(completions, 3);
  assert.equal(maxRunning, 1);
});

test('a failed collection is reported and the next scheduled collection still executes', async () => {
  const abort = new AbortController();
  let attempts = 0;
  const errors: unknown[] = [];
  const results: CollectionResult[] = [];
  await runScheduler({
    intervalMs: 1, signal: abort.signal,
    collect: async () => { if (++attempts === 1) throw new Error('offline'); return RESULT; },
    onResult: (result) => { results.push(result); abort.abort(); },
    onError: (error) => errors.push(error),
  });
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(results, [RESULT]);
});

test('aborting a long interval stops promptly', async () => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10);
  try {
    let calls = 0;
    await runScheduler({
      intervalMs: 60_000, signal: abort.signal,
      collect: async () => { calls++; return RESULT; },
      onResult: () => {}, onError: (error) => { throw error; },
    });
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); }
});
