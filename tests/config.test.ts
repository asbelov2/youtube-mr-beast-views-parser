import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_MS, MRBEAST_CHANNEL_ID, MRBEAST_GAMING_CHANNEL_ID, readConfig, readPublicConfig } from '../src/config.js';

test('defaults to both official channels, 14 days and five minutes', () => {
  const config = readConfig({ YOUTUBE_API_KEY: 'test-key' });
  assert.deepEqual(config.channelIds, [MRBEAST_CHANNEL_ID, MRBEAST_GAMING_CHANNEL_ID]);
  assert.equal(config.trackingWindowMs, 14 * DAY_MS);
  assert.equal(config.pollIntervalMs, 5 * 60_000);
  assert.equal(config.fullDiscoveryIntervalMs, 60 * 60_000);
});

test('deduplicates channel lists and gives them precedence over the legacy single-channel setting', () => {
  assert.deepEqual(readPublicConfig({ YOUTUBE_CHANNEL_ID: MRBEAST_CHANNEL_ID }).channelIds, [MRBEAST_CHANNEL_ID]);
  assert.deepEqual(readPublicConfig({
    YOUTUBE_CHANNEL_ID: MRBEAST_CHANNEL_ID,
    YOUTUBE_CHANNEL_IDS: ` ${MRBEAST_GAMING_CHANNEL_ID}, ${MRBEAST_GAMING_CHANNEL_ID} `,
  }).channelIds, [MRBEAST_GAMING_CHANNEL_ID]);
  for (const value of [`${MRBEAST_CHANNEL_ID},`, `,${MRBEAST_CHANNEL_ID}`, '@MrBeastGaming']) {
    assert.throws(() => readPublicConfig({ YOUTUBE_CHANNEL_IDS: value }), /channel ID/);
  }
});

test('supports configurable window and fractional intervals', () => {
  const config = readConfig({
    YOUTUBE_API_KEY: 'test-key', TRACKING_WINDOW_DAYS: '21', POLL_INTERVAL_MINUTES: '0.5',
    FULL_DISCOVERY_INTERVAL_MINUTES: '30',
  });
  assert.equal(config.trackingWindowMs, 21 * DAY_MS);
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.fullDiscoveryIntervalMs, 30 * 60_000);
});

test('rejects missing keys and invalid channel IDs without printing credentials', () => {
  assert.throws(() => readConfig({}), /Set YOUTUBE_API_KEY/);
  assert.throws(() => readConfig({ YOUTUBE_API_KEY: ' ', }), /Set YOUTUBE_API_KEY/);
  assert.throws(() => readConfig({ YOUTUBE_API_KEY: 'secret', YOUTUBE_CHANNEL_ID: '@MrBeast' }), /channel ID/);
});

for (const name of ['TRACKING_WINDOW_DAYS', 'POLL_INTERVAL_MINUTES', 'FULL_DISCOVERY_INTERVAL_MINUTES']) {
  test(`rejects invalid ${name}`, () => {
    for (const bad of ['0', '-1', 'abc', 'NaN', 'Infinity', '1e30', '0.00000000001']) {
      assert.throws(() => readConfig({ YOUTUBE_API_KEY: 'test-key', [name]: bad }), new RegExp(name));
    }
  });
}

test('web settings can be read without an API key and reject invalid ports', () => {
  assert.equal(readPublicConfig({}).webPort, 3000);
  assert.equal(readPublicConfig({}).webHost, '127.0.0.1');
  assert.equal(readPublicConfig({ WEB_PORT: '0' }).webPort, 0);
  for (const port of ['-1', '65536', '1.5', 'abc']) {
    assert.throws(() => readPublicConfig({ WEB_PORT: port }), /WEB_PORT/);
  }
  assert.throws(() => readPublicConfig({ TRACKING_WINDOW_DAYS: '100000000' }), /retention window/);
});
