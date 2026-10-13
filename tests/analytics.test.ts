import assert from 'node:assert/strict';
import test from 'node:test';
import { compareGrowth, forecastViews } from '../src/analytics.js';
import type { Snapshot } from '../src/types.js';
import { NOW } from './helpers.js';

function series(count: number, fn: (hours: number) => number, step = 1): Snapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    observedAt: new Date(NOW.getTime() + i * step * 3_600_000).toISOString(),
    viewCount: String(Math.round(fn(i * step))),
  }));
}

test('comparison reports current growth and acceleration against the previous equal period', () => {
  const history = series(5, (hours) => 1_000 + 100 * hours ** 2);
  const result = compareGrowth(history, new Date(history[2]!.observedAt));
  assert.equal(result.available, true);
  assert.equal(result.viewDelta, '1200');
  assert.equal(result.previousPeriodDelta, '400');
  assert.equal(result.viewsPerHour, 600);
  assert.equal(result.growthChangePercent, 200);
  assert.equal(result.percentChange, 85.7142);
});

test('custom time uses an actual observation at or before the requested time', () => {
  const history = series(4, (hours) => 1_000 + hours * 100);
  const result = compareGrowth(history, new Date(NOW.getTime() + 1.5 * 3_600_000));
  assert.equal(result.referenceAt, history[1]!.observedAt);
  assert.equal(result.referenceViewCount, '1100');
  assert.equal(result.viewDelta, '200');
});

test('comparisons do not manufacture observations before history or after the last point', () => {
  const history = series(3, () => 1_000);
  assert.equal(compareGrowth(history, new Date(NOW.getTime() - 1)).available, false);
  assert.equal(compareGrowth(history, new Date(NOW.getTime() + 3 * 3_600_000)).available, false);
  assert.equal(compareGrowth([], NOW).available, false);
});

test('growth arithmetic stays exact above Number.MAX_SAFE_INTEGER and allows downward corrections', () => {
  const history = [
    { observedAt: NOW.toISOString(), viewCount: '9007199254740993123' },
    { observedAt: new Date(NOW.getTime() + 3_600_000).toISOString(), viewCount: '9007199254740993023' },
  ];
  assert.equal(compareGrowth(history, NOW).viewDelta, '-100');
});

test('irregular samples compare normalized rates rather than unequal raw period totals', () => {
  const history = [
    { observedAt: NOW.toISOString(), viewCount: '1000' },
    { observedAt: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(), viewCount: '1300' },
    { observedAt: new Date(NOW.getTime() + 5 * 3_600_000).toISOString(), viewCount: '1500' },
  ];
  const result = compareGrowth(history, new Date(history[1]!.observedAt));
  assert.equal(result.previousPeriodDelta, '300');
  assert.equal(result.viewDelta, '200');
  assert.equal(result.growthChangePercent, 0);
});

test('zero previous growth has no fabricated acceleration percentage', () => {
  const history = series(3, (hours) => hours < 2 ? 1_000 : 1_100);
  const result = compareGrowth(history, new Date(history[1]!.observedAt));
  assert.equal(result.previousPeriodDelta, '0');
  assert.equal(result.growthChangePercent, null);
});

test('linear regression recovers a known slope and extrapolates to the requested time', () => {
  const result = forecastViews(series(12, (hours) => 1_000_000 + hours * 120), 6);
  assert.equal(result.model, 'linear');
  assert.equal(result.predictedViews, 1_002_040);
  assert.ok(result.rSquared! > 0.99999);
  assert.ok(result.holdoutMae! < 0.001);
  assert.equal(result.predictedAt, new Date(NOW.getTime() + 17 * 3_600_000).toISOString());
  assert.equal(result.curve.length, 161);
  assert.match(result.formula!, /120 · t/);
});

test('auto selection detects a saturating process and predicts a bounded future', () => {
  const history = series(25, (hours) => 1_000_000 + 500_000 * (1 - Math.exp(-hours / 4)), 2);
  const result = forecastViews(history, 168);
  assert.equal(result.model, 'saturation');
  assert.ok(result.predictedViews! <= 1_500_010);
  assert.ok(result.predictedViews! >= 1_499_990);
  assert.ok(result.rSquared! > 0.9999);
  assert.ok(result.holdoutMae! < 1);
});

test('logarithmic model recovers a known logarithmic curve', () => {
  const history = series(25, (hours) => 1_000_000 + 100_000 * Math.log1p(hours / 4), 2);
  const result = forecastViews(history, 24, 'logarithmic');
  assert.equal(result.model, 'logarithmic');
  const expected = 1_000_000 + 100_000 * Math.log1p(72 / 4);
  assert.ok(Math.abs(result.predictedViews! - expected) < 2);
  assert.ok(result.holdoutMae! < 1);
});

test('early history uses a simple model and explains unvalidated long extrapolation', () => {
  const result = forecastViews(series(3, (hours) => 1_000 + 100 * hours, 0.1), 24);
  assert.equal(result.available, true);
  assert.equal(result.model, 'linear');
  assert.equal(result.holdoutMae, null);
  assert.ok(result.warnings.length >= 3);
  assert.equal(forecastViews(series(3, (hours) => 1_000 + 100 * hours), 6, 'saturation').available, false);
});

test('flat histories predict a plateau and retain corrections in the measured data', () => {
  const flat = forecastViews(series(10, () => 500_000), 24);
  assert.equal(flat.predictedViews, 500_000);
  assert.ok(flat.warnings.some((warning) => warning.includes('одинаковы')));
  const falling = forecastViews(series(10, (hours) => 500_000 - hours * 100), 6);
  assert.ok(falling.warnings.some((warning) => warning.includes('снижения')));
  assert.equal(falling.curve[0]!.views, falling.curve.at(-1)!.views);
});

test('missing, unsafe or duplicate-only data cannot produce a numerical forecast', () => {
  assert.equal(forecastViews([], 24).available, false);
  assert.equal(forecastViews(series(2, () => 100), 24).available, false);
  assert.equal(forecastViews(series(3, () => 100), 0).available, false);
  assert.equal(forecastViews(series(3, () => 100), 169).available, false);
  const duplicate = { observedAt: NOW.toISOString(), viewCount: '100' };
  assert.equal(forecastViews([duplicate, duplicate, duplicate], 24).available, false);
  assert.equal(forecastViews(series(3, () => 100).map((point) => ({ ...point, viewCount: '9007199254740993123' })), 24).available, false);
});

test('archived video forecasts extend into the future from now, with a gap warning', () => {
  const history = series(5, (hours) => 1_000 + 100 * hours);
  const later = new Date(NOW.getTime() + 48 * 3_600_000);
  const result = forecastViews(history, 6, 'auto', later);
  assert.equal(result.predictedAt, new Date(later.getTime() + 6 * 3_600_000).toISOString());
  assert.equal(result.predictedViews, 6_400);
  assert.ok(result.warnings.some((warning) => warning.includes('период без измерений')));
});
