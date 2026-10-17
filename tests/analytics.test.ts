import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDayAgo, compareGrowth, forecastViews } from '../src/analytics.js';
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

test('thirteen-hour growth compares with the same window ending 24 hours earlier', () => {
  const history = series(49, (h) => 1_000 + 100 * h ** 2);
  const current = compareGrowth(history, new Date(history[35]!.observedAt));
  const yesterday = compareDayAgo(history, current);
  assert.equal(yesterday.available, true);
  assert.equal(yesterday.requestedStartAt, history[11]!.observedAt);
  assert.equal(yesterday.requestedEndAt, history[24]!.observedAt);
  assert.equal(yesterday.referenceAt, history[11]!.observedAt);
  assert.equal(yesterday.currentAt, history[24]!.observedAt);
  assert.equal(current.viewDelta, '107900');
  assert.equal(yesterday.viewDelta, '45500');
  assert.equal(yesterday.viewDeltaChange, '62400');
  assert.equal(yesterday.viewDeltaChangePercent, 137.1428);
  assert.equal(yesterday.rateChangePercent, 137.1428);
  assert.equal(yesterday.viewsPerHour, 3500);
  assert.notEqual(yesterday.viewDelta, current.previousPeriodDelta);
});

test('daily rate comparison accounts for unequal polling intervals', () => {
  const history = [0, 1, 24, 25 + 5 / 60].map((h, i) => ({
    observedAt: new Date(NOW.getTime() + h * 3_600_000).toISOString(),
    viewCount: ['1000', '1120', '3880', '4010'][i]!,
  }));
  const current = compareGrowth(history, new Date(NOW.getTime() + (24 + 5 / 60) * 3_600_000));
  const yesterday = compareDayAgo(history, current);
  assert.equal(current.viewsPerHour, 120);
  assert.equal(yesterday.viewsPerHour, 120);
  assert.equal(yesterday.viewDeltaChangePercent, 8.3333);
  assert.equal(yesterday.rateChangePercent, 0);
});

test('daily comparisons require history near both target boundaries and distinct observations', () => {
  const short = series(3, (h) => 1000 + h * 100);
  assert.equal(compareDayAgo(short, compareGrowth(short, NOW)).available, false);
  const sparse = [0, 40, 41].map((h) => ({ observedAt: new Date(NOW.getTime() + h * 3_600_000).toISOString(), viewCount: String(1000 + h * 100) }));
  const missing = compareDayAgo(sparse, compareGrowth(sparse, new Date(sparse[1]!.observedAt)));
  assert.equal(missing.available, false);
  assert.match(missing.reason!, /близких замеров/);
  const history = series(49, (h) => 1000 + h * 100);
  assert.equal(compareDayAgo(history, compareGrowth(history, new Date(history.at(-1)!.observedAt))).available, false);
});

test('daily growth remains exact for large counters and has no percentages for a zero or negative baseline', () => {
  const base = 900719925474099312345n;
  for (const priorDelta of [0n, -10n, 120n]) {
    const history = [0, 1, 24, 25].map((h, i) => ({
      observedAt: new Date(NOW.getTime() + h * 3_600_000).toISOString(),
      viewCount: (base + [0n, priorDelta, 2400n, 2640n][i]!).toString(),
    }));
    const result = compareDayAgo(history, compareGrowth(history, new Date(history[2]!.observedAt)));
    assert.equal(result.available, true);
    assert.equal(result.viewDelta, priorDelta.toString());
    assert.equal(result.viewDeltaChange, (240n - priorDelta).toString());
    assert.equal(result.viewDeltaChangePercent, priorDelta > 0n ? 100 : null);
    assert.equal(result.rateChangePercent, priorDelta > 0n ? 100 : null);
  }
});

test('daily comparison also shifts windows longer than a day by 24 hours', () => {
  const history = series(73, (h) => 1000 + h * h * 100);
  const result = compareDayAgo(history, compareGrowth(history, new Date(history[24]!.observedAt)));
  assert.equal(result.referenceAt, history[0]!.observedAt);
  assert.equal(result.currentAt, history[48]!.observedAt);
  assert.equal(result.viewDeltaChangePercent, 100);
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

// Independent numerical integration of a positive daily rate, rather than the
// analytic expression used by the fitter. Also exercises an arbitrary phase.
function dailySeries(hours = 96, step = 0.5, amplitude = 0.7, phase = 1.1): Snapshot[] {
  let views = 1_000_000;
  const history: Snapshot[] = [];
  const rate = (t: number) => 80_000 * Math.exp(-t / 48) * (1 + amplitude * Math.sin(2 * Math.PI * t / 24 + phase));
  for (let i = 0; i <= Math.round(hours / step); i++) {
    const t = i * step;
    if (i) {
      // Composite Simpson quadrature over the interval.
      const divisions = 20;
      const delta = step / divisions;
      let sum = rate(t - step) + rate(t);
      for (let j = 1; j < divisions; j++) sum += (j % 2 ? 4 : 2) * rate(t - step + j * delta);
      views += sum * delta / 3;
    }
    history.push({ observedAt: new Date(NOW.getTime() + t * 3_600_000).toISOString(), viewCount: String(Math.round(views)) });
  }
  return history;
}

test('daily saturation learns phase and amplitude and improves the next-day forecast', () => {
  const full = dailySeries();
  const training = full.filter((p) => Date.parse(p.observedAt) <= NOW.getTime() + 72 * 3_600_000);
  const result = forecastViews(training, 24, 'daily-saturation');
  const saturation = forecastViews(training, 24, 'saturation');
  const truth = Number(full.at(-1)!.viewCount);
  assert.equal(result.available, true, result.reason ?? '');
  assert.equal(result.model, 'daily-saturation');
  assert.equal(result.holdoutPoints, 48);
  assert.ok(result.holdoutMae! < 1, `MAE ${result.holdoutMae}`);
  assert.ok(result.holdoutMae! < saturation.holdoutMae! * 0.1);
  assert.ok(Math.abs(result.predictedViews! - truth) < 2);
  assert.ok(result.rSquared! > 0.99999);
  assert.match(result.formula!, /sin\(2π · u \/ 24/);
  assert.equal(forecastViews(training, 24).model, 'daily-saturation');
  assert.ok(result.warnings.some((warning) => warning.includes('24 часа')));
});

test('daily saturation remains monotone and bounded even with excessive oscillations or declining measurements', () => {
  for (const history of [dailySeries(96, 0.5, 2.5), series(193, (t) => 5_000_000 - t * 1_000, 0.5), series(193, () => 5_000_000, 0.5)]) {
    const result = forecastViews(history, 168, 'daily-saturation');
    assert.equal(result.available, true);
    assert.ok(result.curve.every((p, i) => Number.isFinite(p.views) && p.views >= 0 && (i === 0 || p.views >= result.curve[i - 1]!.views - 1e-6)));
    assert.ok(result.predictedViews! < 20_000_000);
  }
  const plateau = forecastViews(dailySeries(96, 0.5), 168, 'daily-saturation');
  const last = plateau.curve.at(-1)!.views;
  const previous = plateau.curve.at(-2)!.views;
  assert.ok(last - previous < 5_000);
});

test('daily model needs several covered cycles and auto keeps simpler models when seasonality does not help', () => {
  for (const history of [dailySeries(48), dailySeries(72).filter((_, i) => i < 30 || i > 60), series(4, (t) => 1000 + t, 24)]) {
    const result = forecastViews(history, 24, 'daily-saturation');
    assert.equal(result.available, false);
  }
  for (const history of [series(193, (t) => 1_000_000 + t * 1000, 0.5),
    series(193, (t) => 1_000_000 + 500_000 * (1 - Math.exp(-t / 48)), 0.5)]) {
    assert.notEqual(forecastViews(history, 24).model, 'daily-saturation');
  }
});

test('daily phase follows absolute time across midnight and irregular observations', () => {
  const full = dailySeries(96, 0.5, 0.65, -2.4);
  const history = full.slice(1).filter((_, i) => i % 5 !== 2);
  const result = forecastViews(history, 24, 'daily-saturation');
  const expected = dailySeries(120, 0.5, 0.65, -2.4).at(-1)!;
  assert.equal(result.available, true);
  assert.ok(Math.abs(result.predictedViews! - Number(expected.viewCount)) < 1000);
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
