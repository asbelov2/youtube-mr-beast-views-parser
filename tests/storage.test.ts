import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('retention deletes a video and all snapshots only after twice the tracking window', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.record([
    video({ id: 'expired', publishedAt: new Date(NOW.getTime() - 28 * DAY_MS - 1).toISOString() }),
    video({ id: 'boundary', publishedAt: new Date(NOW.getTime() - 28 * DAY_MS).toISOString() }),
    video({ id: 'archived', publishedAt: new Date(NOW.getTime() - 20 * DAY_MS).toISOString() }),
    video({ id: 'other', channelId: 'another-channel', publishedAt: new Date(NOW.getTime() - 40 * DAY_MS).toISOString() }),
  ], NOW.toISOString());
  assert.equal(store.pruneExpired(MRBEAST_CHANNEL_ID, NOW, 28 * DAY_MS), 1);
  assert.deepEqual(store.history('expired'), []);
  assert.equal(store.history('boundary').length, 1);
  assert.equal(store.history('archived').length, 1);
  assert.equal(store.history('other').length, 1);
  assert.equal(store.pruneExpired(MRBEAST_CHANNEL_ID, NOW, 28 * DAY_MS), 0);
  assert.equal(store.listVideos(MRBEAST_CHANNEL_ID).length, 2);
  assert.doesNotMatch([...store.csv()].join(''), /expired/);
});

test('retention follows a changed tracking window rather than a hard-coded 28 days', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.record([video({ publishedAt: new Date(NOW.getTime() - 20 * DAY_MS).toISOString() })], NOW.toISOString());
  assert.equal(store.pruneExpired(MRBEAST_CHANNEL_ID, NOW, 42 * DAY_MS), 0);
  assert.equal(store.pruneExpired(MRBEAST_CHANNEL_ID, NOW, 14 * DAY_MS), 1);
});

test('an existing database gains Shorts exclusions without replacing any history, across restarts', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mrbeast-short-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'old.sqlite');
  // Exact legacy tables: there is no Shorts metadata table yet.
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE videos (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, title TEXT NOT NULL,
    published_at TEXT NOT NULL, discovered_at TEXT NOT NULL);
    CREATE TABLE view_snapshots (video_id TEXT NOT NULL REFERENCES videos(id), observed_at TEXT NOT NULL,
    view_count TEXT NOT NULL, PRIMARY KEY(video_id, observed_at));`);
  for (const v of [video(), video({ id: 'short' }), video({ id: 'other', channelId: 'other-channel' })]) {
    old.prepare('INSERT INTO videos VALUES (?, ?, ?, ?, ?)').run(v.id, v.channelId, v.title, v.publishedAt, NOW.toISOString());
    old.prepare('INSERT INTO view_snapshots VALUES (?, ?, ?)').run(v.id, NOW.toISOString(), '900719925474099312345');
  }
  old.close();
  let store = new Store(path);
  assert.equal(store.listVideos(MRBEAST_CHANNEL_ID).length, 2);
  store.excludeShorts(MRBEAST_CHANNEL_ID, ['short', 'short', 'missing', 'other']);
  store.close(); store = new Store(path);
  t.after(() => store.close());
  assert.deepEqual(store.listVideos(MRBEAST_CHANNEL_ID).map((v) => v.id), ['fresh-video']);
  assert.deepEqual(store.activeVideoIds(MRBEAST_CHANNEL_ID, NOW, 14 * DAY_MS), ['fresh-video']);
  assert.equal(store.listVideos('other-channel').length, 1);
  assert.doesNotMatch([...store.csv()].join(''), /"short"/);
  assert.equal(store.history('short')[0]!.viewCount, '900719925474099312345');
  assert.equal(store.history('fresh-video')[0]!.viewCount, '900719925474099312345');
  // Retention can still remove excluded videos: no orphaned classification or FK errors.
  assert.equal(store.pruneExpired(MRBEAST_CHANNEL_ID, new Date(NOW.getTime() + 30 * DAY_MS), 28 * DAY_MS), 2);
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(raw.prepare('SELECT count(*) AS n FROM excluded_shorts').get()!.n, 0);
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { raw.close(); }
});
