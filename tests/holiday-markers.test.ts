import assert from 'node:assert/strict';
import test from 'node:test';
import type { HolidayEvent } from '../src/calendar-types.js';
import { clusterHolidayMarkers, holidayMarkers, type HolidayMarkerSource } from '../src/web/holiday-markers.js';

const time = Date.parse;
const hour = 3_600_000;
const holiday: HolidayEvent = { country: 'US', countryLabel: 'США', name: 'Thanksgiving Day', date: '2026-11-26',
  startAt: '2026-11-26T05:00:00Z', endAt: '2026-11-27T05:00:00Z', timeZone: 'America/New_York', kind: 'public', substitute: false };
const main: HolidayMarkerSource = { id: 'main', title: 'Main', publishedAt: '2026-11-24T16:00:00Z', holidays: [holiday], color: '#fff' };

test('holiday markers use the middle of a local day, cover zoomed fragments and exclude the ending midnight', () => {
  const markers = holidayMarkers([main], main.publishedAt, time(main.publishedAt), time('2026-11-28Z'));
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.time, time('2026-11-26T17:00:00Z'));
  const fragment = holidayMarkers([main], main.publishedAt, time('2026-11-27T01:00:00Z'), time('2026-11-27T04:00:00Z'));
  assert.equal(fragment.length, 1);
  assert.ok(fragment[0]!.time >= time('2026-11-27T01:00:00Z') && fragment[0]!.time <= time('2026-11-27T04:00:00Z'));
  assert.equal(holidayMarkers([main], main.publishedAt, time(holiday.endAt), time(holiday.endAt) + hour).length, 0);
});

test('overlay markers keep original dates and stay inside their actual history', () => {
  const oldHoliday = { ...holiday, date: '2026-11-11', name: 'Veterans Day', startAt: '2026-11-11T05:00:00Z', endAt: '2026-11-12T05:00:00Z' };
  const old: HolidayMarkerSource = { ...main, id: 'old', title: 'Old', publishedAt: '2026-11-07T16:00:00Z',
    holidays: [oldHoliday], startAt: time('2026-11-07T16:00:00Z'), endAt: time('2026-11-12T16:00:00Z') };
  const markers = holidayMarkers([main, old], main.publishedAt, time(main.publishedAt), time('2026-11-30Z'));
  const mark = markers.find((m) => m.source.id === 'old')!;
  assert.equal(mark.originalTime, time('2026-11-11T17:00:00Z'));
  assert.equal(mark.time, time('2026-11-28T17:00:00Z'));
  assert.equal(mark.events[0]!.date, '2026-11-11');
  assert.equal(holidayMarkers([{ ...old, endAt: time('2026-11-10Z') }], main.publishedAt, time(main.publishedAt), time('2026-11-30Z')).length, 0);
});

test('same-day events share badges and nearby badges cluster without dropping countries or videos', () => {
  const bank = { ...holiday, name: 'Bank day', kind: 'bank' as const };
  const source = { ...main, holidays: [holiday, { ...holiday, name: 'Another public day' }, bank] };
  const ordinary = holidayMarkers([source], main.publishedAt, time(main.publishedAt), time('2026-11-28Z'));
  assert.equal(ordinary.length, 1);
  assert.equal(ordinary[0]!.events.length, 2);
  assert.equal(holidayMarkers([source], main.publishedAt, time(main.publishedAt), time('2026-11-28Z'), true)[0]!.events.length, 3);
  const extra = { ...main, id: 'other', holidays: [{ ...holiday, country: 'CA', countryLabel: 'Канада',
    startAt: '2026-11-26T06:00:00Z', endAt: '2026-11-27T06:00:00Z' }] };
  const all = holidayMarkers([main, extra], main.publishedAt, time(main.publishedAt), time('2026-11-28Z'));
  const clusters = clusterHolidayMarkers(all, (t) => (t - time(holiday.startAt)) / hour, 0, 200);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.marks.length, 2);
  assert.deepEqual(clusters[0]!.marks.map((m) => m.source.id), ['main', 'other']);
  assert.equal(clusterHolidayMarkers(all, (t) => (t - time(holiday.startAt)) / hour * 40, 0, 1000).length, 2);
});

test('a holiday on a 23-hour Sunday is hidden as a weekend day', () => {
  const shortDay = { ...holiday, date: '2026-03-08', startAt: '2026-03-08T05:00:00Z', endAt: '2026-03-09T04:00:00Z' };
  assert.equal(holidayMarkers([{ ...main, holidays: [shortDay] }], main.publishedAt, time(shortDay.startAt), time(shortDay.endAt)).length, 0);
});

test('weekend filtering uses an overlay original local date and keeps weekday substitute holidays', () => {
  const saturday = { ...holiday, date: '2026-07-04', name: 'Independence Day', startAt: '2026-07-04T04:00:00Z', endAt: '2026-07-05T04:00:00Z' };
  const friday = { ...saturday, date: '2026-07-03', startAt: '2026-07-03T04:00:00Z', endAt: '2026-07-04T04:00:00Z', substitute: true };
  const old = { ...main, publishedAt: '2026-07-03T16:00:00Z', holidays: [saturday, friday, { ...saturday, kind: 'bank' as const }] };
  const target = '2026-07-06T16:00:00Z';
  const marks = holidayMarkers([old], target, time(target), time('2026-07-10Z'), true);
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.events[0]!.date, '2026-07-03');
  assert.equal(marks[0]!.events[0]!.substitute, true);
  assert.equal(new Date(marks[0]!.time).getUTCDay(), 1); // Friday shifted onto Monday.
});
