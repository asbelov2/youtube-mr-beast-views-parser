import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { MRBEAST_CHANNEL_ID, MRBEAST_GAMING_CHANNEL_ID, readPublicConfig } from '../src/config.js';
import type { DashboardIndex, DashboardVideo } from '../src/dashboard-types.js';
import { createDashboardServer } from '../src/server.js';
import { Store } from '../src/storage.js';
import { NOW, video } from './helpers.js';

async function fixture(t: TestContext, empty = false, lastHour = 12) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  if (!empty) for (let i = 0; i <= lastHour; i++) {
    store.record([video({ viewCount: String(1_000_000 + 100 * i) })], new Date(NOW.getTime() + i * 3_600_000).toISOString());
  }
  const server = createDashboardServer({
    store, config: readPublicConfig({ WEB_PORT: '0' }), webRoot: resolve('src/web'),
    now: () => new Date(NOW.getTime() + (lastHour + 1) * 3_600_000),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { store, base: `http://127.0.0.1:${address.port}` };
}

test('dashboard API lists saved videos and settings without credentials', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/videos`);
  assert.equal(response.status, 200);
  const data = await response.json() as DashboardIndex;
  assert.equal(data.videos.length, 1);
  assert.equal(data.videos[0]!.viewCount, '1001200');
  assert.equal(data.videos[0]!.observations, 13);
  assert.equal(data.videos[0]!.tracking, true);
  assert.equal(data.pollIntervalMinutes, 5);
  assert.equal(data.retentionDays, 28);
  assert.equal(JSON.stringify(data).includes('apiKey'), false);
});

test('detail API supplies history, interval comparison and a fitted future curve', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/videos/fresh-video?compareHours=1&forecastHours=1`);
  assert.equal(response.status, 200);
  const data = await response.json() as DashboardVideo;
  assert.equal(data.history.length, 13);
  assert.equal(data.comparison.viewDelta, '100');
  assert.equal(data.comparison.growthChangePercent, 0);
  assert.equal(data.dayComparison.available, false);
  assert.equal(data.forecast.model, 'linear');
  assert.equal(data.forecast.curve.length, 161);
  assert.equal(data.forecast.predictedViews, 1_001_400);
  assert.equal(data.forecast.predictedAt, new Date(NOW.getTime() + 14 * 3_600_000).toISOString());
});

test('comparison API supports new presets, arbitrary hours and the same interval yesterday', async (t) => {
  const { base } = await fixture(t, false, 48);
  for (const hours of [2, 3, 4, 8, 12, 13]) {
    const response = await fetch(`${base}/api/videos/fresh-video?compareHours=${hours}`);
    assert.equal(response.status, 200);
    const data = await response.json() as DashboardVideo;
    assert.equal(data.comparison.viewDelta, String(hours * 100));
    assert.equal(data.dayComparison.available, true);
    assert.equal(data.dayComparison.viewDelta, String(hours * 100));
    assert.equal(data.dayComparison.viewsPerHour, 100);
    assert.equal(data.dayComparison.viewDeltaChangePercent, 0);
    assert.equal(data.dayComparison.rateChangePercent, 0);
  }
  const query = new URLSearchParams({ compareAt: new Date(NOW.getTime() + 35 * 3_600_000).toISOString() });
  const custom = await (await fetch(`${base}/api/videos/fresh-video?${query}`)).json() as DashboardVideo;
  assert.equal(custom.dayComparison.viewDelta, '1300');
  assert.equal((await fetch(`${base}/api/videos/fresh-video?compareHours=13.5`)).status, 200);
});

test('daily saturation is selectable early through the API with provisional warnings', async (t) => {
  const { base } = await fixture(t, false, 72);
  const response = await fetch(`${base}/api/videos/fresh-video?model=daily-saturation&forecastHours=24`);
  assert.equal(response.status, 200);
  const data = await response.json() as DashboardVideo;
  assert.equal(data.forecast.available, true);
  assert.equal(data.forecast.model, 'daily-saturation');
  assert.equal(data.forecast.holdoutPoints, 24);
  const short = await fixture(t);
  const early = await (await fetch(`${short.base}/api/videos/fresh-video?model=daily-saturation`)).json() as DashboardVideo;
  assert.equal(early.forecast.available, true);
  assert.equal(early.forecast.model, 'daily-saturation');
  assert.ok(early.forecast.warnings.some((warning) => warning.includes('Предварительная')));
  const tooFew = await fixture(t, false, 6);
  const unavailable = await (await fetch(`${tooFew.base}/api/videos/fresh-video?model=daily-saturation`)).json() as DashboardVideo;
  assert.equal(unavailable.forecast.available, false);
  assert.match(unavailable.forecast.reason!, /8 наблюдений/);
});

test('custom time, missing history and unknown videos have distinct outcomes', async (t) => {
  const { base } = await fixture(t);
  const params = new URLSearchParams({ compareAt: new Date(NOW.getTime() + 4.5 * 3_600_000).toISOString() });
  const custom = await (await fetch(`${base}/api/videos/fresh-video?${params}`)).json() as DashboardVideo;
  assert.equal(custom.comparison.referenceAt, new Date(NOW.getTime() + 4 * 3_600_000).toISOString());
  assert.equal(custom.comparison.viewDelta, '800');
  const missing = await (await fetch(`${base}/api/videos/fresh-video?compareHours=24`)).json() as DashboardVideo;
  assert.equal(missing.comparison.available, false);
  assert.match(missing.comparison.reason!, /История/);
  assert.equal((await fetch(`${base}/api/videos/unknown`)).status, 404);
});

test('fit API selects publication-relative bounds and keeps complete history and current comparisons', async (t) => {
  const { base } = await fixture(t, false, 96);
  // The fixture was first observed a full day after publication.
  const response = await fetch(`${base}/api/videos/fresh-video?fitStartDay=2&fitEndDay=3&model=linear&compareHours=1&forecastHours=1`);
  assert.equal(response.status, 200);
  const data = await response.json() as DashboardVideo;
  assert.equal(data.history.length, 97);
  assert.equal(data.fitRange.observations, 25);
  assert.equal(data.fitRange.firstObservedAt, new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
  assert.equal(data.fitRange.lastObservedAt, new Date(NOW.getTime() + 48 * 3_600_000).toISOString());
  assert.equal(data.forecast.originAt, data.fitRange.firstObservedAt);
  assert.equal(data.forecast.predictedViews, 1_009_800);
  assert.equal(data.comparison.viewDelta, '100');
  assert.ok(Array.isArray(data.holidays));
  assert.ok(data.holidays.some((holiday) => holiday.country === 'BR'));
  const empty = await (await fetch(`${base}/api/videos/fresh-video?fitStartDay=10`)).json() as DashboardVideo;
  assert.equal(empty.history.length, 97);
  assert.equal(empty.forecast.available, false);
  for (const query of ['fitStartDay=-1', 'fitEndDay=0', 'fitStartDay=3&fitEndDay=2', 'fitEndDay=NaN', 'fitEndDay=']) {
    assert.equal((await fetch(`${base}/api/videos/fresh-video?${query}`)).status, 400);
  }
});

test('invalid periods and model choices are rejected instead of producing invalid predictions', async (t) => {
  const { base } = await fixture(t);
  for (const query of ['forecastHours=0', 'forecastHours=169', 'forecastHours=NaN', 'compareHours=-1', 'model=quadratic', 'compareAt=invalid', 'compareAt=2026-10-13T12:00:00Z&compareHours=1']) {
    assert.equal((await fetch(`${base}/api/videos/fresh-video?${query}`)).status, 400, query);
  }
});

test('web server serves local assets and CSV but exposes neither source files nor writes', async (t) => {
  const { base } = await fixture(t);
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /views-chart/);
  assert.match(html.headers.get('content-security-policy')!, /script-src 'self'/);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  assert.equal((await fetch(`${base}/favicon.svg`)).status, 200);
  for (const path of ['/.env', '/package.json', '/src/config.ts', '/../package.json']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  const csv = await fetch(`${base}/api/export.csv`);
  assert.match(csv.headers.get('content-disposition')!, /attachment/);
  assert.match(await csv.text(), /1001200/);
  assert.equal((await fetch(`${base}/api/videos`, { method: 'POST' })).status, 405);
});

test('an empty database is valid and does not create example or fabricated data', async (t) => {
  const { base } = await fixture(t, true);
  const data = await (await fetch(`${base}/api/videos`)).json() as DashboardIndex;
  assert.deepEqual(data.videos, []);
});

test('previously collected Shorts disappear from the index, detail endpoint and CSV without losing snapshots', async (t) => {
  const { base, store } = await fixture(t);
  store.record([video({ id: 'saved-short' })], NOW.toISOString());
  store.excludeShorts(MRBEAST_CHANNEL_ID, ['saved-short']);
  const index = await (await fetch(`${base}/api/videos`)).json() as DashboardIndex;
  assert.deepEqual(index.videos.map((v) => v.id), ['fresh-video']);
  assert.equal((await fetch(`${base}/api/videos/saved-short`)).status, 404);
  assert.doesNotMatch(await (await fetch(`${base}/api/export.csv`)).text(), /saved-short/);
  assert.equal(store.history('saved-short').length, 1);
});

test('both channels appear in publication order and Gaming history is accessible without unrelated channels', async (t) => {
  const { base, store } = await fixture(t);
  const gaming = video({ id: 'gaming-video', channelId: MRBEAST_GAMING_CHANNEL_ID, publishedAt: NOW.toISOString() });
  store.record([gaming, video({ id: 'unrelated', channelId: 'another-channel' })], NOW.toISOString());
  const data = await (await fetch(`${base}/api/videos`)).json() as DashboardIndex;
  assert.deepEqual(data.videos.map((item) => item.channelId), [MRBEAST_GAMING_CHANNEL_ID, MRBEAST_CHANNEL_ID]);
  assert.equal(data.videos[0]!.publishedAt, NOW.toISOString());
  const detail = await (await fetch(`${base}/api/videos/gaming-video`)).json() as DashboardVideo;
  assert.equal(detail.video.channelId, MRBEAST_GAMING_CHANNEL_ID);
  assert.equal(detail.history[0]!.viewCount, gaming.viewCount);
  assert.equal((await fetch(`${base}/api/videos/unrelated`)).status, 404);
  assert.deepEqual(store.listVideos([]), []);
});
