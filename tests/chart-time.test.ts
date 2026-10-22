import assert from 'node:assert/strict';
import test from 'node:test';
import { ageLabel, alignHistory, originalTime } from '../src/web/chart-time.js';
import { clockValue, CLOCK_ZONES } from '../src/web/world-clocks.js';

test('past videos align by elapsed age while tooltips recover their original publication dates', () => {
  const past = '2026-10-01T16:00:00Z';
  const main = '2026-10-22T19:00:00Z';
  const source = [{ observedAt: '2026-10-02T22:00:00Z', viewCount: '1500000' }];
  const aligned = alignHistory(source, past, main);
  assert.equal(aligned[0]!.x - Date.parse(main), 30 * 3_600_000);
  assert.equal(aligned[0]!.y, 1_500_000);
  assert.equal(originalTime(aligned[0]!.x, past, main), Date.parse(source[0]!.observedAt));
  assert.equal(source[0]!.observedAt, '2026-10-02T22:00:00Z');
  assert.equal(ageLabel(30 * 3_600_000), '1 д 6 ч');
});

test('world clocks follow daylight saving transitions and fractional offsets', () => {
  const summer = new Date('2026-07-01T00:00:00Z');
  const winter = new Date('2026-01-01T00:00:00Z');
  assert.equal(CLOCK_ZONES.length, 7);
  assert.equal(clockValue(winter, 'America/Los_Angeles').offset, 'UTC-8');
  assert.equal(clockValue(summer, 'America/Los_Angeles').offset, 'UTC-7');
  assert.equal(clockValue(winter, 'America/New_York').offset, 'UTC-5');
  assert.equal(clockValue(summer, 'America/New_York').offset, 'UTC-4');
  assert.equal(clockValue(winter, 'Europe/Berlin').offset, 'UTC+1');
  assert.equal(clockValue(summer, 'Europe/Berlin').offset, 'UTC+2');
  assert.equal(clockValue(summer, 'America/Sao_Paulo').offset, 'UTC-3');
  assert.equal(clockValue(summer, 'Asia/Jakarta').time, '07:00:00');
  assert.equal(clockValue(summer, 'Asia/Manila').time, '08:00:00');
  assert.equal(clockValue(summer, 'Asia/Kolkata').time, '05:30:00');
});
