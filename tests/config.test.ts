import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_MS, MRBEAST_CHANNEL_ID, readConfig } from '../src/config.js';

test('defaults to MrBeast, 14 days and five minutes', () => {
  const config = readConfig({ YOUTUBE_API_KEY: 'test-key' });
  assert.equal(config.channelId, MRBEAST_CHANNEL_ID);
  assert.equal(config.trackingWindowMs, 14 * DAY_MS);
  assert.equal(config.pollIntervalMs, 5 * 60_000);
  assert.equal(config.fullDiscoveryIntervalMs, 60 * 60_000);
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
