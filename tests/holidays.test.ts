import assert from 'node:assert/strict';
import test from 'node:test';
import { holidaysBetween, videoHolidays } from '../src/holidays.js';
import type { VideoSummary } from '../src/types.js';
import { holidaysAt, holidayTooltipLines } from '../src/web/holiday-info.js';

const calendar = holidaysBetween(Date.parse('2026-01-01Z'), Date.parse('2027-01-02Z'));

test('calendar covers every requested region, movable holidays and observed federal days', () => {
  assert.deepEqual([...new Set(calendar.map((h) => h.country))].sort(), ['BR', 'CA', 'EU', 'GB', 'ID', 'IN', 'MX', 'PH', 'US']);
  assert.ok(calendar.some((h) => h.country === 'US' && h.date === '2026-07-03' && h.substitute));
  assert.ok(calendar.some((h) => h.country === 'US' && h.date === '2026-11-26' && h.name === 'Thanksgiving Day'));
  assert.ok(calendar.some((h) => h.country === 'CA' && h.date === '2026-10-12' && h.name === 'Thanksgiving'));
  assert.ok(calendar.some((h) => h.country === 'GB' && h.date === '2026-08-31'));
  for (const [country, date] of [['MX', '2026-09-16'], ['BR', '2026-09-07'], ['IN', '2026-08-15'], ['PH', '2026-06-12'], ['ID', '2026-08-17']]) {
    assert.ok(calendar.some((h) => h.country === country && h.date === date), `${country}: ${date}`);
  }
  assert.equal(calendar.some((h) => h.country === 'US' && h.date === '2026-10-31'), false);
  assert.equal(calendar.some((h) => h.country === 'EU' && h.date === '2026-05-01'), false);
  assert.ok(calendar.some((h) => h.country === 'BR' && h.kind === 'bank'));
});

test('hovering uses each country local date and excludes the next local midnight', () => {
  const beforeUsMidnight = holidaysAt(calendar, Date.parse('2026-01-01T04:30:00Z'));
  assert.equal(beforeUsMidnight.some((h) => h.country === 'US'), false);
  assert.equal(beforeUsMidnight.some((h) => h.country === 'ID'), true);
  assert.equal(holidaysAt(calendar, Date.parse('2026-01-01T05:00:00Z')).some((h) => h.country === 'US'), true);
  assert.equal(holidaysAt(calendar, Date.parse('2026-01-02T05:00:00Z')).some((h) => h.country === 'US'), false);
  const text = holidayTooltipLines(beforeUsMidnight).join('\n');
  assert.match(text, /Новый год/);
  assert.match(text, /Индонезия/);
});

test('calendar extends to the age of an older overlay even beyond the current forecast', () => {
  const main: VideoSummary = { id: 'main', channelId: 'channel', title: 'Main', publishedAt: '2026-12-20T12:00:00Z',
    firstObservedAt: '2026-12-22T12:00:00Z', lastObservedAt: '2026-12-22T12:00:00Z', viewCount: '1000', observations: 1 };
  const old: VideoSummary = { ...main, id: 'old', publishedAt: '2026-12-01T12:00:00Z', lastObservedAt: '2026-12-15T12:00:00Z' };
  const expanded = videoHolidays(main, [main, old], new Date(main.lastObservedAt));
  assert.ok(expanded.some((h) => h.country === 'EU' && h.date === '2027-01-01'));
  const withoutOverlay = videoHolidays(main, [main], new Date(main.lastObservedAt));
  assert.equal(withoutOverlay.some((h) => h.date === '2027-01-01'), false);
});
