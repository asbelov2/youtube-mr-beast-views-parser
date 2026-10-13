import { setTimeout as sleep } from 'node:timers/promises';
import type { CollectionResult } from './types.js';

// Timers longer than this overflow in Node. Split long intervals into safe chunks.
const MAX_TIMER_MS = 2_147_483_647;

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_TIMER_MS);
    await sleep(chunk, undefined, { signal });
    remaining -= chunk;
  }
}

interface SchedulerOptions {
  intervalMs: number;
  signal: AbortSignal;
  collect: (signal: AbortSignal) => Promise<CollectionResult>;
  onResult: (result: CollectionResult) => void;
  onError: (error: unknown) => void;
}

export async function runScheduler(options: SchedulerOptions): Promise<void> {
  while (!options.signal.aborted) {
    const startedAt = performance.now();
    try {
      const result = await options.collect(options.signal);
      options.onResult(result);
    } catch (error) {
      if (options.signal.aborted) return;
      options.onError(error);
    }
    // Await completion before scheduling another run; collections cannot overlap.
    // A slow run is followed by a full interval rather than a rapid catch-up loop.
    const elapsed = performance.now() - startedAt;
    const delay = elapsed < options.intervalMs ? options.intervalMs - elapsed : options.intervalMs;
    try {
      await wait(delay, options.signal);
    } catch (error) {
      if (options.signal.aborted) return;
      throw error;
    }
  }
}
