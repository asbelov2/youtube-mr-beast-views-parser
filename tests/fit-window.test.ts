import assert from 'node:assert/strict';
import test from 'node:test';
import { fitVideoForecast, readFitWindow } from '../src/fit-window.js';

const published = Date.parse('2026-10-01T19:00:17Z');
const time = (hour: number) => new Date(published + hour * 3_600_000).toISOString();
const history = Array.from({ length: 97 }, (_, h) => ({ observedAt: time(h), viewCount: String(1000 + h * 100) }));

test('fit bounds use age since publication, including exact endpoints and delayed discovery', () => {
  for (const [startDay, endDay, first, last, count] of [[2, null, 48, 96, 49], [1, 2, 24, 48, 25], [0, 3, 12, 72, 61]] as const) {
    const result = fitVideoForecast(history.slice(12), new Date(published).toISOString(), 24, 'linear', new Date(time(96)), { startDay, endDay });
    assert.equal(result.fitRange.firstObservedAt, time(first));
    assert.equal(result.fitRange.lastObservedAt, time(last));
    assert.equal(result.fitRange.observations, count);
    assert.equal(result.forecast.predictedAt, time(120));
    assert.equal(result.forecast.predictedViews, 13_000);
  }
});

test('outliers outside the selected period cannot affect its fit or validation', () => {
  const corrupted = history.map((p, h) => ({ ...p, viewCount: h < 24 || h > 48 ? '99999999' : p.viewCount }));
  const result = fitVideoForecast(corrupted, new Date(published).toISOString(), 24, 'linear', new Date(time(96)), { startDay: 1, endDay: 2 });
  assert.equal(result.forecast.predictedViews, 13_000);
  assert.ok(result.forecast.holdoutMae! < 0.001);
  assert.equal(corrupted.length, 97);
  assert.equal(corrupted.at(-1)!.viewCount, '99999999');
  assert.ok(result.forecast.warnings.some((warning) => warning.includes('Более поздние замеры не используются')));
});

test('empty ranges remain unavailable; fractional days and latest-observation ends are supported', () => {
  const empty = fitVideoForecast(history, new Date(published).toISOString(), 24, 'linear', new Date(time(96)), { startDay: 5, endDay: null });
  assert.equal(empty.forecast.available, false);
  assert.equal(empty.fitRange.observations, 0);
  assert.equal(empty.fitRange.firstObservedAt, null);
  assert.deepEqual(readFitWindow(new URLSearchParams('fitStartDay=0.5&fitEndDay=1.5')), { startDay: 0.5, endDay: 1.5 });
  assert.deepEqual(readFitWindow(new URLSearchParams()), { startDay: 0, endDay: null });
  for (const query of ['fitStartDay=-1', 'fitStartDay=', 'fitEndDay=', 'fitStartDay=2&fitEndDay=1', 'fitEndDay=0', 'fitStartDay=Infinity', 'fitEndDay=NaN', 'fitEndDay=3651']) {
    assert.throws(() => readFitWindow(new URLSearchParams(query)), /Участок аппроксимации/);
  }
});
