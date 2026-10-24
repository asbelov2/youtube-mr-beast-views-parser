import assert from 'node:assert/strict';
import test from 'node:test';
import { holidaysBetween, videoHolidays } from '../src/holidays.js';
import type { VideoSummary } from '../src/types.js';
import { holidaysAt, holidayTooltipLines, upcomingHolidays } from '../src/web/holiday-info.js';

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

test('graph tooltips omit Saturday and Sunday holidays by local date while keeping observed weekdays', () => {
  const fridayInUs = holidaysAt(calendar, Date.parse('2026-07-04T02:00:00Z'));
  assert.ok(fridayInUs.some((h) => h.country === 'US' && h.date === '2026-07-03' && h.substitute));
  assert.equal(holidaysAt(calendar, Date.parse('2026-07-04T18:00:00Z')).some((h) => h.country === 'US'), false);
  // India has already entered Saturday while UTC is still Friday.
  assert.equal(holidaysAt(calendar, Date.parse('2026-08-14T20:00:00Z')).some((h) => h.country === 'IN'), false);
  // Indonesia has entered Monday while UTC is still Sunday.
  assert.ok(holidaysAt(calendar, Date.parse('2026-08-16T18:00:00Z')).some((h) => h.country === 'ID' && h.date === '2026-08-17'));
  // The separate upcoming list remains a complete calendar, including weekend holidays.
  assert.ok(upcomingHolidays(calendar, Date.parse('2026-07-03Z')).some((h) => h.country === 'US' && h.date === '2026-07-04'));
});

test('calendar covers upcoming holidays independently of the forecast and preserves long overlays', () => {
  const main: VideoSummary = { id: 'main', channelId: 'channel', title: 'Main', publishedAt: '2026-12-20T12:00:00Z',
    firstObservedAt: '2026-12-22T12:00:00Z', lastObservedAt: '2026-12-22T12:00:00Z', viewCount: '1000', observations: 1 };
  const old: VideoSummary = { ...main, id: 'old', publishedAt: '2026-05-01T12:00:00Z', lastObservedAt: '2026-12-15T12:00:00Z' };
  const expanded = videoHolidays(main, [main, old], new Date(main.lastObservedAt));
  assert.ok(expanded.some((h) => h.country === 'EU' && h.date === '2027-01-01'));
  assert.ok(expanded.some((h) => h.country === 'US' && h.date === '2027-07-04'));
  const withoutOverlay = videoHolidays(main, [main], new Date(main.lastObservedAt));
  assert.ok(withoutOverlay.some((h) => h.country === 'EU' && h.date === '2027-01-01'));
  assert.equal(withoutOverlay.some((h) => h.date === '2027-07-04'), false);
});

test('upcoming days off include ongoing local days, stop at 90 days and exclude bank days by default', () => {
  const asOf = Date.parse('2026-12-31T18:00:00Z');
  const future = holidaysBetween(asOf - 86_400_000, asOf + 110 * 86_400_000);
  const events = upcomingHolidays([...future].reverse(), asOf);
  assert.ok(events.some((h) => h.country === 'ID' && h.date === '2027-01-01'));
  assert.equal(events.some((h) => h.country === 'US' && h.date === '2027-01-01'), true);
  assert.ok(events.every((h) => h.kind === 'public' && Date.parse(h.endAt) > asOf && Date.parse(h.startAt) < asOf + 90 * 86_400_000));
  assert.ok(events.every((h, i) => i === 0 || Date.parse(events[i - 1]!.startAt) <= Date.parse(h.startAt)));
  const withBank = upcomingHolidays(future, asOf, true);
  assert.ok(withBank.some((h) => h.kind === 'bank'));
  assert.ok(withBank.length > events.length);
  const usNewYear = events.find((h) => h.country === 'US' && h.date === '2027-01-01')!;
  assert.equal(upcomingHolidays([usNewYear], Date.parse(usNewYear.endAt)).length, 0);
  assert.equal(upcomingHolidays([usNewYear], Date.parse(usNewYear.startAt) - 90 * 86_400_000).length, 0);
});
