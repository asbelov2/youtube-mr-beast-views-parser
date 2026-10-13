import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Collector } from '../src/collector.js';
import { DAY_MS, MRBEAST_CHANNEL_ID } from '../src/config.js';
import { Store } from '../src/storage.js';
import { YouTubeClient } from '../src/youtube.js';
import { apiVideo, CONFIG, NOW } from './helpers.js';

test('real HTTP -> uploads -> view counts -> persistent SQLite -> CSV, including restart and expiry', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mrbeast-integration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'views.sqlite');
  const publishedAt = new Date(NOW.getTime() - DAY_MS).toISOString();
  let count = '100';
  const server = createServer((req, res) => {
    assert.equal(req.headers['x-goog-api-key'], 'test-key');
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/channels')) {
      res.end(JSON.stringify({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'uploads-id' } } }] }));
    } else if (url.pathname.endsWith('/playlistItems')) {
      res.end(JSON.stringify({ items: [{ contentDetails: { videoId: 'fresh-video', videoPublishedAt: publishedAt } }] }));
    } else if (url.pathname.endsWith('/videos')) {
      res.end(JSON.stringify({ items: [apiVideo({ statistics: { viewCount: count } })] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const localFetch: typeof fetch = (input, init) => {
    const original = new URL(String(input));
    const local = new URL(original.pathname + original.search, `http://127.0.0.1:${address.port}`);
    return fetch(local, init);
  };
  const youtube = new YouTubeClient({ apiKey: 'test-key', channelId: MRBEAST_CHANNEL_ID, fetch: localFetch });
  let now = NOW;
  let store = new Store(databasePath);
  try {
    let collector = new Collector(CONFIG, youtube, store, () => now);
    assert.equal((await collector.collect()).recorded, 1);
    count = '120';
    now = new Date(NOW.getTime() + 60_000);
    assert.equal((await collector.collect()).recorded, 1);
    store.close();
    store = new Store(databasePath);
    collector = new Collector(CONFIG, youtube, store, () => now);
    count = '130';
    now = new Date(NOW.getTime() + 120_000);
    assert.equal((await collector.collect()).recorded, 1);
    now = new Date(Date.parse(publishedAt) + 14 * DAY_MS);
    assert.equal((await collector.collect()).recorded, 0);
    const rows = [...store.csv()];
    assert.equal(rows.length, 4);
    assert.match(rows[1]!, /"100"/);
    assert.match(rows[2]!, /"120"/);
    assert.match(rows[3]!, /"130"/);
  } finally { store.close(); }
});
