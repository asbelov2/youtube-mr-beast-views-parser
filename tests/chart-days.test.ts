import assert from 'node:assert/strict';
import test from 'node:test';
import { createDayViewLookup, publicationDays } from '../src/web/chart-days.js';

const publishedAt = '2026-10-14T16:00:01.000Z'; // 19:00:01 Moscow time.
const start = Date.parse(publishedAt);
const DAY = 86_400_000;

test('day markers repeat the publication time every 24 hours, starting the next day', () => {
  const marks = publicationDays(publishedAt, start, start + 3 * DAY);
  assert.deepEqual(marks.map((mark) => mark.day), [1, 2, 3]);
  assert.equal(new Date(marks[0]!.time).toISOString(), '2026-10-15T16:00:01.000Z');
  assert.equal(marks[2]!.time, start + 3 * DAY);
});

test('zoomed views contain only visible day markers and retain exact boundary timestamps', () => {
  assert.deepEqual(publicationDays(publishedAt, start + DAY + 1, start + 2 * DAY), [{ time: start + 2 * DAY, day: 2 }]);
  assert.deepEqual(publicationDays(publishedAt, start + 1, start + DAY - 1), []);
  assert.deepEqual(publicationDays(publishedAt, start - DAY, start), []);
  assert.deepEqual(publicationDays('invalid', start, start + DAY), []);
  assert.deepEqual(publicationDays(publishedAt, start + DAY, start), []);
});

test('day tooltips use the boundary time, preserving exact samples and interpolating nearby observations', () => {
  const time = start + DAY;
  const history = [-300_000, 300_000].map((offset, i) => ({
    observedAt: new Date(time + offset).toISOString(), viewCount: ['1000', '2000'][i]!,
  }));
  const lookup = createDayViewLookup(history, [
    { time: history[0]!.observedAt, views: 1100 }, { time: history[1]!.observedAt, views: 2100 },
  ], 600_000);
  assert.deepEqual(lookup(time), { actual: { views: '1500', interpolated: true }, model: 1600, future: false });
  assert.deepEqual(lookup(time - 300_000).actual, { views: '1000', interpolated: false });
  assert.deepEqual(lookup(time + 300_000).actual, { views: '2000', interpolated: false });
  assert.equal(history.length, 2);
  assert.equal(history[0]!.viewCount, '1000');
});

test('day tooltip interpolation preserves very large counters and actual downward corrections', () => {
  const base = 900719925474099312345n;
  const history = [0, 300_000].map((offset, i) => ({
    observedAt: new Date(start + offset).toISOString(), viewCount: (base - BigInt(i * 101)).toString(),
  }));
  const lookup = createDayViewLookup(history, [], 600_000);
  assert.deepEqual(lookup(start).actual, { views: base.toString(), interpolated: false });
  assert.deepEqual(lookup(start + 150_000).actual, { views: (base - 50n).toString(), interpolated: true });
});

test('day tooltips do not fill long collection gaps or extrapolate measurements into the future', () => {
  const history = [0, 3_600_000].map((offset, i) => ({ observedAt: new Date(start + offset).toISOString(), viewCount: String(1000 + i * 100) }));
  const lookup = createDayViewLookup(history, [
    { time: new Date(start).toISOString(), views: 1000 },
    { time: new Date(start + 2 * DAY).toISOString(), views: 5800 },
  ], 600_000);
  assert.equal(lookup(start + 300_000).actual, null);
  assert.deepEqual(lookup(start + DAY), { actual: null, model: 3400, future: true });
  assert.equal(lookup(start - 1).actual, null);
  assert.equal(lookup(start - 1).model, null);
  assert.equal(lookup(start + 3 * DAY).model, null);
  assert.equal(lookup(NaN).actual, null);
});
