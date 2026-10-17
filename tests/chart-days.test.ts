import assert from 'node:assert/strict';
import test from 'node:test';
import { publicationDays } from '../src/web/chart-days.js';

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
