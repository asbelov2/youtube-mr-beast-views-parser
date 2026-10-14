import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MRBEAST_GAMING_CHANNEL_ID, readPublicConfig } from '../src/config.js';
import type { OfflineData } from '../src/dashboard-types.js';
import { writeReport } from '../src/report.js';
import { Store } from '../src/storage.js';
import { NOW, video } from './helpers.js';

test('standalone report embeds histories and publication dates from both channels and escapes video titles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mrbeast-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.record([
    video(), video({ id: 'gaming', channelId: MRBEAST_GAMING_CHANNEL_ID, title: '</script><script>unsafe</script>' }),
  ], NOW.toISOString());
  const path = join(directory, 'report.html');
  await writeReport(store, readPublicConfig({}), path, NOW);
  const html = await readFile(path, 'utf8');
  const payload = html.match(/<script id="offline-data" type="application\/json">(.*?)<\/script>/s);
  assert.ok(payload);
  assert.doesNotMatch(payload[1]!, /<script>/);
  const data = JSON.parse(payload[1]!) as OfflineData;
  assert.equal(data.index.videos.length, 2);
  assert.equal(data.index.videos.find((v) => v.id === 'gaming')!.publishedAt, video().publishedAt);
  assert.equal(data.histories.gaming!.length, 1);
  assert.equal(data.histories['fresh-video']!.length, 1);
  assert.match(data.csv, new RegExp(MRBEAST_GAMING_CHANNEL_ID));
});
