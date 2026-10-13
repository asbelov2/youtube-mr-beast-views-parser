import assert from 'node:assert/strict';
import test from 'node:test';
import { Collector } from '../src/collector.js';
import { DAY_MS } from '../src/config.js';
import { Store } from '../src/storage.js';
import { isWithinTrackingWindow } from '../src/types.js';
import { CONFIG, NOW, video } from './helpers.js';

test('uses an exact elapsed duration: stops at 14 days and rejects future/invalid dates', () => {
  assert.equal(isWithinTrackingWindow(new Date(NOW.getTime() - 14 * DAY_MS + 1).toISOString(), NOW, 14 * DAY_MS), true);
  assert.equal(isWithinTrackingWindow(new Date(NOW.getTime() - 14 * DAY_MS).toISOString(), NOW, 14 * DAY_MS), false);
  assert.equal(isWithinTrackingWindow(new Date(NOW.getTime() - 14 * DAY_MS - 1).toISOString(), NOW, 14 * DAY_MS), false);
  assert.equal(isWithinTrackingWindow(NOW.toISOString(), NOW, 14 * DAY_MS), true);
  assert.equal(isWithinTrackingWindow(new Date(NOW.getTime() + 1).toISOString(), NOW, 14 * DAY_MS), false);
  assert.equal(isWithinTrackingWindow('invalid', NOW, 14 * DAY_MS), false);
});

test('records only eligible channel videos and retains exact large view counts', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const data = [
    video({ viewCount: '900719925474099312345' }),
    video({ id: 'expired', publishedAt: new Date(NOW.getTime() - 15 * DAY_MS).toISOString() }),
    video({ id: 'boundary', publishedAt: new Date(NOW.getTime() - 14 * DAY_MS).toISOString() }),
    video({ id: 'future', publishedAt: new Date(NOW.getTime() + DAY_MS).toISOString() }),
    video({ id: 'other-channel', channelId: 'another-channel' }),
  ];
  const collector = new Collector(CONFIG, {
    recentVideoIds: async () => data.map((v) => v.id),
    videos: async () => data,
  }, store, () => NOW);
  assert.deepEqual(await collector.collect(), {
    observedAt: NOW.toISOString(), candidates: 5, recorded: 1, skipped: 4,
  });
  const csv = [...store.csv()].join('');
  assert.equal([...store.csv()].length, 2);
  assert.match(csv, /900719925474099312345/);
  assert.doesNotMatch(csv, /expired|boundary|future|other-channel/);
});

test('rechecks the window after requests: a video may expire during collection', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let calls = 0;
  const nearBoundary = video({ publishedAt: new Date(NOW.getTime() - 14 * DAY_MS + 1).toISOString() });
  const collector = new Collector(CONFIG, {
    recentVideoIds: async () => [nearBoundary.id],
    videos: async () => [nearBoundary],
  }, store, () => new Date(NOW.getTime() + calls++));
  assert.equal((await collector.collect()).recorded, 0);
  assert.equal([...store.csv()].length, 1);
});

test('existing active videos keep updating between full scans', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let now = NOW;
  const flags: boolean[] = [];
  const requested: string[][] = [];
  const collector = new Collector(CONFIG, {
    recentVideoIds: async (_cutoff, _signal, fullScan) => {
      flags.push(fullScan ?? true);
      return flags.length === 1 ? ['fresh-video'] : [];
    },
    videos: async (ids) => {
      requested.push(ids);
      return ids.map((id) => video({ id, viewCount: String(requested.length * 100) }));
    },
  }, store, () => now);
  await collector.collect();
  now = new Date(NOW.getTime() + 60_000);
  await collector.collect();
  now = new Date(NOW.getTime() + CONFIG.fullDiscoveryIntervalMs);
  await collector.collect();
  assert.deepEqual(flags, [true, false, true]);
  assert.deepEqual(requested, [['fresh-video'], ['fresh-video'], ['fresh-video']]);
  assert.equal([...store.csv()].length, 4);
});

test('aging out stops statistics requests but preserves old observations', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let now = NOW;
  const v = video({ publishedAt: new Date(NOW.getTime() - 14 * DAY_MS + 60_000).toISOString() });
  const requested: string[][] = [];
  const collector = new Collector(CONFIG, {
    recentVideoIds: async (cutoff) => Date.parse(v.publishedAt) > cutoff.getTime() ? [v.id] : [],
    videos: async (ids) => { requested.push(ids); return ids.map(() => v); },
  }, store, () => now);
  await collector.collect();
  now = new Date(NOW.getTime() + 60_000);
  assert.equal((await collector.collect()).recorded, 0);
  assert.deepEqual(requested, [[v.id], []]);
  assert.equal([...store.csv()].length, 2);
});

test('shrinking and growing the configured window changes eligibility without deleting history', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const v = video({ publishedAt: new Date(NOW.getTime() - 10 * DAY_MS).toISOString() });
  const youtube = {
    recentVideoIds: async (cutoff: Date) => Date.parse(v.publishedAt) > cutoff.getTime() ? [v.id] : [],
    videos: async (ids: string[]) => ids.map(() => v),
  };
  assert.equal((await new Collector(CONFIG, youtube, store, () => NOW).collect()).recorded, 1);
  const later = new Date(NOW.getTime() + 60_000);
  assert.equal((await new Collector({ ...CONFIG, trackingWindowMs: 7 * DAY_MS }, youtube, store, () => later).collect()).recorded, 0);
  assert.equal((await new Collector({ ...CONFIG, trackingWindowMs: 21 * DAY_MS }, youtube, store, () => later).collect()).recorded, 1);
  assert.equal([...store.csv()].length, 3);
});

test('a failed cycle saves no partial observations and retries full discovery next time', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const flags: boolean[] = [];
  let fail = true;
  const collector = new Collector(CONFIG, {
    recentVideoIds: async (_cutoff, _signal, fullScan) => { flags.push(fullScan!); return ['fresh-video']; },
    videos: async () => {
      if (fail) throw new Error('API unavailable');
      return [video()];
    },
  }, store, () => NOW);
  await assert.rejects(collector.collect(), /API unavailable/);
  assert.equal([...store.csv()].length, 1);
  fail = false;
  assert.equal((await collector.collect()).recorded, 1);
  assert.deepEqual(flags, [true, true]);
});

test('an aborted collection does not write observations', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const abort = new AbortController();
  const collector = new Collector(CONFIG, {
    recentVideoIds: async () => ['fresh-video'],
    videos: async () => { abort.abort(); return [video()]; },
  }, store, () => NOW);
  await assert.rejects(collector.collect(abort.signal), { name: 'AbortError' });
  assert.equal([...store.csv()].length, 1);
});

test('automatic cleanup runs even when YouTube is unavailable', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.record([
    video({ id: 'expired', publishedAt: new Date(NOW.getTime() - 29 * DAY_MS).toISOString() }),
    video({ id: 'archived', publishedAt: new Date(NOW.getTime() - 20 * DAY_MS).toISOString() }),
  ], NOW.toISOString());
  const collector = new Collector(CONFIG, {
    recentVideoIds: async () => { throw new Error('offline'); }, videos: async () => [],
  }, store, () => NOW);
  await assert.rejects(collector.collect(), /offline/);
  assert.equal(store.history('expired').length, 0);
  assert.equal(store.history('archived').length, 1);
});
