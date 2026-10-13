import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DAY_MS, MRBEAST_CHANNEL_ID } from '../src/config.js';
import { Store } from '../src/storage.js';
import { NOW, video } from './helpers.js';

test('persists history across restarts and safely escapes CSV titles', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mrbeast-storage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'nested', 'views.sqlite');
  let store = new Store(path);
  const v = video({ title: 'Hello, "YouTube"\nAgain', viewCount: '9007199254740993' });
  store.record([v], NOW.toISOString());
  store.close();
  store = new Store(path);
  try {
    assert.deepEqual(store.activeVideoIds(MRBEAST_CHANNEL_ID, NOW, 14 * DAY_MS), [v.id]);
    const csv = [...store.csv()].join('');
    assert.match(csv, /"Hello, ""YouTube""\nAgain"/);
    assert.match(csv, /9007199254740993/);
    assert.equal([...store.csv()].length, 2);
  } finally { store.close(); }
});

test('same-time writes are idempotent and lower subsequent counts are retained', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.record([video({ viewCount: '1000' })], NOW.toISOString());
  store.record([video({ viewCount: '1000' })], NOW.toISOString());
  store.record([video({ viewCount: '950' })], new Date(NOW.getTime() + 60_000).toISOString());
  assert.equal([...store.csv()].length, 3);
  assert.match([...store.csv()].join(''), /"1000"\r\n/);
  assert.match([...store.csv()].join(''), /"950"\r\n/);
});

test('rolls back the entire database transaction if a write fails', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  assert.throws(() => store.record([
    video(), video({ id: 'invalid', title: null as unknown as string }),
  ], NOW.toISOString()), /NOT NULL/);
  assert.equal([...store.csv()].length, 1);
  assert.deepEqual(store.activeVideoIds(MRBEAST_CHANNEL_ID, NOW, 14 * DAY_MS), []);
});
