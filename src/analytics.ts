import type { Snapshot } from './types.js';
import { fitDailySaturation, predictDailySaturation, type DailyParameters } from './daily-saturation.js';

const HOUR_MS = 3_600_000;
export type ModelKind = 'linear' | 'logarithmic' | 'saturation' | 'daily-saturation';
export type ModelChoice = ModelKind | 'auto';

export interface Comparison {
  available: boolean;
  reason: string | null;
  requestedAt: string;
  referenceAt: string | null;
  referenceViewCount: string | null;
  currentAt: string | null;
  currentViewCount: string | null;
  viewDelta: string | null;
  percentChange: number | null;
  viewsPerHour: number | null;
  previousPeriodDelta: string | null;
  growthChangePercent: number | null;
  previousReferenceAt: string | null;
}

function percent(delta: bigint, baseline: bigint): number | null {
  if (baseline <= 0n) return null;
  const result = Number(delta * 1_000_000n / baseline) / 10_000;
  return Number.isFinite(result) ? result : null;
}

export function compareGrowth(history: Snapshot[], requestedAt: Date): Comparison {
  const sorted = [...history].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const latest = sorted.at(-1);
  const result: Comparison = {
    available: false, reason: null, requestedAt: requestedAt.toISOString(),
    referenceAt: null, referenceViewCount: null,
    currentAt: latest?.observedAt ?? null, currentViewCount: latest?.viewCount ?? null,
    viewDelta: null, percentChange: null, viewsPerHour: null,
    previousPeriodDelta: null, growthChangePercent: null, previousReferenceAt: null,
  };
  if (!latest) return { ...result, reason: 'Пока нет наблюдений.' };
  if (requestedAt.getTime() > Date.parse(latest.observedAt)) {
    return { ...result, reason: 'Выбранное время позже последнего наблюдения.' };
  }
  const reference = sorted.findLast((point) => Date.parse(point.observedAt) <= requestedAt.getTime());
  if (!reference) return { ...result, reason: 'История ещё не охватывает выбранное время.' };
  const delta = BigInt(latest.viewCount) - BigInt(reference.viewCount);
  const elapsedMs = Date.parse(latest.observedAt) - Date.parse(reference.observedAt);
  const rate = elapsedMs > 0 ? Number(delta) * HOUR_MS / elapsedMs : NaN;
  const previous = elapsedMs > 0 ? sorted.findLast((point) =>
    Date.parse(point.observedAt) <= Date.parse(reference.observedAt) - elapsedMs,
  ) : undefined;
  // Normalize unequal sampling intervals before comparing growth rates.
  const previousDelta = previous ? BigInt(reference.viewCount) - BigInt(previous.viewCount) : null;
  const previousMs = previous ? Date.parse(reference.observedAt) - Date.parse(previous.observedAt) : 0;
  const growthChange = previousDelta !== null && previousDelta > 0n && elapsedMs > 0
    ? percent(delta * BigInt(previousMs) - previousDelta * BigInt(elapsedMs), previousDelta * BigInt(elapsedMs))
    : null;
  return {
    ...result, available: true, referenceAt: reference.observedAt,
    referenceViewCount: reference.viewCount, viewDelta: delta.toString(),
    percentChange: percent(delta, BigInt(reference.viewCount)),
    viewsPerHour: Number.isFinite(rate) ? rate : null,
    previousPeriodDelta: previousDelta?.toString() ?? null,
    growthChangePercent: growthChange, previousReferenceAt: previous?.observedAt ?? null,
  };
}

export interface DayComparison {
  available: boolean;
  reason: string | null;
  requestedStartAt: string | null;
  requestedEndAt: string | null;
  referenceAt: string | null;
  currentAt: string | null;
  viewDelta: string | null;
  viewsPerHour: number | null;
  viewDeltaChange: string | null;
  viewDeltaChangePercent: number | null;
  rateChangePercent: number | null;
}

/** The selected window shifted by exactly 24 hours, using real observations only. */
export function compareDayAgo(history: Snapshot[], current: Comparison, maxSampleLagMs = 15 * 60_000): DayComparison {
  const empty: DayComparison = {
    available: false, reason: null, requestedStartAt: null, requestedEndAt: null,
    referenceAt: null, currentAt: null, viewDelta: null, viewsPerHour: null,
    viewDeltaChange: null, viewDeltaChangePercent: null, rateChangePercent: null,
  };
  if (!current.available || !current.currentAt || !current.referenceAt || current.viewDelta === null) {
    return { ...empty, reason: 'Для сравнения со вчера сначала нужен прирост за выбранный интервал.' };
  }
  const startMs = Date.parse(current.requestedAt) - 24 * HOUR_MS;
  const endMs = Date.parse(current.currentAt) - 24 * HOUR_MS;
  const result = { ...empty, requestedStartAt: new Date(startMs).toISOString(), requestedEndAt: new Date(endMs).toISOString() };
  const sorted = [...history].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const start = sorted.findLast((point) => Date.parse(point.observedAt) <= startMs);
  const end = sorted.findLast((point) => Date.parse(point.observedAt) <= endMs);
  if (!start || !end) return { ...result, reason: 'Ещё нет истории за тот же интервал сутками раньше.' };
  if (startMs - Date.parse(start.observedAt) > maxSampleLagMs || endMs - Date.parse(end.observedAt) > maxSampleLagMs) {
    return { ...result, reason: 'Нет близких замеров на границах вчерашнего интервала.' };
  }
  const elapsedMs = Date.parse(end.observedAt) - Date.parse(start.observedAt);
  const currentMs = Date.parse(current.currentAt) - Date.parse(current.referenceAt);
  if (elapsedMs <= 0 || currentMs <= 0) return { ...result, reason: 'Для сравнения со вчера нужны разные замеры на обеих границах интервала.' };
  const delta = BigInt(end.viewCount) - BigInt(start.viewCount);
  const currentDelta = BigInt(current.viewDelta);
  const rate = Number(delta) * HOUR_MS / elapsedMs;
  return {
    ...result, available: true, referenceAt: start.observedAt, currentAt: end.observedAt,
    viewDelta: delta.toString(), viewsPerHour: Number.isFinite(rate) ? rate : null,
    viewDeltaChange: (currentDelta - delta).toString(), viewDeltaChangePercent: percent(currentDelta - delta, delta),
    // Compare rates using actual durations when polling timestamps do not align exactly.
    rateChangePercent: percent(currentDelta * BigInt(elapsedMs) - delta * BigInt(currentMs), delta * BigInt(currentMs)),
  };
}

export interface CurvePoint { time: string; views: number }

export interface Forecast {
  available: boolean;
  reason: string | null;
  model: ModelKind | null;
  modelLabel: string | null;
  formula: string | null;
  originAt: string | null;
  rSquared: number | null;
  holdoutMae: number | null;
  holdoutPoints: number;
  historyHours: number;
  forecastHours: number;
  warnings: string[];
  curve: CurvePoint[];
  predictedViews: number | null;
  predictedAt: string | null;
}

interface Candidate { kind: ModelKind; curvature: number }
interface Parameters { a: number; b: number; candidate: Candidate; daily?: DailyParameters }
const CURVATURES = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const LABELS: Record<ModelKind, string> = {
  linear: 'Линейная', logarithmic: 'Логарифмическая', saturation: 'С насыщением',
  'daily-saturation': 'Насыщение + суточный ритм',
};

function basis(candidate: Candidate, x: number): number {
  if (candidate.kind === 'linear') return x;
  if (candidate.kind === 'logarithmic') return Math.log1p(candidate.curvature * x);
  return -Math.expm1(-candidate.curvature * x);
}

function fit(candidate: Candidate, xs: number[], ys: number[], spanHours: number): Parameters {
  if (candidate.kind === 'daily-saturation') {
    const daily = fitDailySaturation(candidate.curvature, spanHours, xs, ys);
    return { a: daily.intercept, b: daily.level, candidate, daily };
  }
  const values = xs.map((x) => basis(candidate, x));
  const meanX = values.reduce((sum, x) => sum + x, 0) / values.length;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  let variance = 0;
  let covariance = 0;
  for (let i = 0; i < values.length; i++) {
    variance += (values[i]! - meanX) ** 2;
    covariance += (values[i]! - meanX) * (ys[i]! - meanY);
  }
  // Cumulative-view forecasts grow or plateau; actual downward corrections remain in the data.
  const b = variance > 1e-14 ? Math.max(0, covariance / variance) : 0;
  return { a: meanY - b * meanX, b, candidate };
}

function predict(params: Parameters, x: number): number {
  if (params.daily) return predictDailySaturation(params.daily, x);
  return params.a + params.b * basis(params.candidate, x);
}

function coefficient(value: number): string {
  return Number(value.toPrecision(7)).toString();
}

function refineCurvature(candidates: Candidate[], xs: number[], ys: number[], spanHours: number): Candidate {
  const error = (candidate: Candidate) => {
    const params = fit(candidate, xs, ys, spanHours);
    return ys.reduce((sum, y, i) => sum + (predict(params, xs[i]!) - y) ** 2, 0);
  };
  const scores = candidates.map(error);
  const best = scores.indexOf(Math.min(...scores));
  let left = candidates[Math.max(0, best - 1)]!.curvature;
  let right = candidates[Math.min(candidates.length - 1, best + 1)]!.curvature;
  const ratio = (Math.sqrt(5) - 1) / 2;
  const kind = candidates[best]!.kind;
  let a = right - ratio * (right - left);
  let b = left + ratio * (right - left);
  let fa = error({ kind, curvature: a });
  let fb = error({ kind, curvature: b });
  for (let i = 0; i < 28; i++) {
    if (fa < fb) {
      right = b; b = a; fb = fa;
      a = right - ratio * (right - left); fa = error({ kind, curvature: a });
    } else {
      left = a; a = b; fa = fb;
      b = left + ratio * (right - left); fb = error({ kind, curvature: b });
    }
  }
  return { kind, curvature: fa < fb ? a : b };
}

export function forecastViews(history: Snapshot[], forecastHours: number, choice: ModelChoice = 'auto', asOf?: Date): Forecast {
  const result: Forecast = {
    available: false, reason: null, model: null, modelLabel: null, formula: null, originAt: null,
    rSquared: null, holdoutMae: null, holdoutPoints: 0, historyHours: 0, forecastHours,
    warnings: [], curve: [], predictedViews: null, predictedAt: null,
  };
  if (!Number.isFinite(forecastHours) || forecastHours <= 0 || forecastHours > 168) {
    return { ...result, reason: 'Горизонт прогноза должен быть больше нуля и не больше 7 дней.' };
  }
  const points = [...new Map(history.map((point) => [point.observedAt, point])).values()]
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (points.length < 3) return { ...result, reason: 'Для аппроксимации нужно хотя бы 3 наблюдения.' };
  if (points.some((point) => !Number.isFinite(Date.parse(point.observedAt)) ||
    !/^\d+$/.test(point.viewCount) || !Number.isSafeInteger(Number(point.viewCount)))) {
    return { ...result, reason: 'Эти значения нельзя безопасно использовать для численной аппроксимации.' };
  }
  const firstMs = Date.parse(points[0]!.observedAt);
  const lastMs = Date.parse(points.at(-1)!.observedAt);
  const spanHours = (lastMs - firstMs) / HOUR_MS;
  if (spanHours <= 0) return { ...result, reason: 'Нужны наблюдения с разным временем.' };
  if (choice !== 'auto' && choice !== 'linear' && points.length < 8) {
    return { ...result, historyHours: spanHours, reason: 'Для нелинейной модели нужно хотя бы 8 наблюдений.' };
  }
  const baseline = Number(points[0]!.viewCount);
  const xs = points.map((point) => (Date.parse(point.observedAt) - firstMs) / (lastMs - firstMs));
  const ys = points.map((point) => Number(point.viewCount) - baseline);
  const candidates: Candidate[] = [{ kind: 'linear', curvature: 0 }];
  for (const kind of ['logarithmic', 'saturation', 'daily-saturation'] as const) {
    for (const curvature of CURVATURES) candidates.push({ kind, curvature });
  }
  let holdoutCount = points.length >= 8 ? Math.max(2, Math.ceil(points.length * 0.2)) : 0;
  // A daily pattern must predict a whole unseen day after at least two training
  // days. Compare every family on the same holdout, even with irregular polling.
  const dailyTrainingCount = Math.min(points.length - holdoutCount,
    points.findIndex((point) => Date.parse(point.observedAt) > lastMs - 24 * HOUR_MS));
  const fullDailyValidation = spanHours >= 72 && points.length >= 25 && dailyTrainingCount >= 16 &&
    (Date.parse(points[dailyTrainingCount - 1]!.observedAt) - firstMs) / HOUR_MS >= 48 &&
    points.every((point, i) => i === 0 || Date.parse(point.observedAt) - Date.parse(points[i - 1]!.observedAt) <= 6 * HOUR_MS);
  if (fullDailyValidation) {
    holdoutCount = points.length - dailyTrainingCount;
  }
  const trainingCount = points.length - holdoutCount;
  const allowed = choice === 'auto'
    ? (holdoutCount ? candidates : candidates.slice(0, 1))
    : candidates.filter((candidate) => candidate.kind === choice);
  const trainXs = xs.slice(0, trainingCount);
  const trainYs = ys.slice(0, trainingCount);
  // Refine on training data only. A grid alone ties accuracy to the exact
  // observed span (which is almost never a round number of hours).
  for (const kind of ['logarithmic', 'saturation', 'daily-saturation'] as const) {
    const family = allowed.filter((candidate) => candidate.kind === kind);
    if (family.length) allowed.push(refineCurvature(family, trainXs, trainYs, spanHours));
  }
  const scored = allowed.map((candidate) => {
    const params = fit(candidate, trainXs, trainYs, spanHours);
    const score = holdoutCount
      ? ys.slice(trainingCount).reduce((sum, y, index) => sum + Math.abs(predict(params, xs[trainingCount + index]!) - y), 0) / holdoutCount
      : 0;
    return { candidate, score };
  }).sort((a, b) => a.score - b.score);
  let selected = scored[0]!;
  const simpler = scored.find((entry) => entry.candidate.kind !== 'daily-saturation');
  if (simpler && selected.candidate.kind === 'daily-saturation' && simpler.score <= selected.score * 1.05 + 1) selected = simpler;
  const linear = scored.find((entry) => entry.candidate.kind === 'linear');
  if (linear && linear.score <= selected.score * 1.05 + 1) selected = linear;
  const params = fit(selected.candidate, xs, ys, spanHours);
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  const residual = ys.reduce((sum, y, index) => sum + (predict(params, xs[index]!) - y) ** 2, 0);
  const total = ys.reduce((sum, y) => sum + (y - meanY) ** 2, 0);
  const rSquared = total > 0 ? 1 - residual / total : (residual < 1e-8 ? 1 : 0);
  const warnings: string[] = [];
  if (params.daily) warnings.push('Суточный период фиксирован: 24 часа. Амплитуда и время пика определены по истории; ритм аудитории может измениться.');
  if (params.daily && !fullDailyValidation) warnings.push('Предварительная суточная модель: ещё нет проверки на полных отложенных сутках. Прогноз может быть неточным, особенно на короткой истории или при разрывах в данных.');
  if (!holdoutCount) warnings.push('Пока мало наблюдений: модель не проверена на отложенных точках.');
  if (spanHours < 24) warnings.push('История короче суток: суточный ритм ещё не наблюдался полностью.');
  const anchorMs = Math.max(lastMs, asOf?.getTime() ?? lastMs);
  if (!Number.isFinite(anchorMs)) return { ...result, reason: 'Некорректное время начала прогноза.' };
  const endMs = anchorMs + forecastHours * HOUR_MS;
  if ((endMs - lastMs) / HOUR_MS > spanHours * 2) warnings.push('Горизонт значительно длиннее истории. Такой прогноз особенно неопределён.');
  if (anchorMs - lastMs > HOUR_MS) warnings.push('Последнее наблюдение старше часа. Прогноз включает период без измерений.');
  if (ys.some((y, i) => i > 0 && y < ys[i - 1]!)) warnings.push('В истории есть снижения просмотров. Модель описывает общий растущий тренд.');
  if (total === 0) warnings.push('Все наблюдения одинаковы: API может ещё не обновить число просмотров.');
  const curve: CurvePoint[] = [];
  for (const [start, end, steps] of [[firstMs, lastMs, 80], [lastMs, endMs, 80]]) {
    for (let i = curve.length ? 1 : 0; i <= steps!; i++) {
      const time = start! + (end! - start!) * i / steps!;
      const views = Math.max(0, baseline + predict(params, (time - firstMs) / (lastMs - firstMs)));
      if (!Number.isFinite(views) || views > Number.MAX_SAFE_INTEGER) {
        return { ...result, historyHours: spanHours, reason: 'Прогноз выходит за безопасный численный диапазон. Выберите меньший горизонт.' };
      }
      curve.push({ time: new Date(time).toISOString(), views });
    }
  }
  const a = coefficient(baseline + params.a);
  const b = coefficient(params.b);
  const k = coefficient(params.candidate.curvature / spanHours);
  const amplitude = params.daily && params.b > 0 ? Math.hypot(params.daily.sine, params.daily.cosine) / params.b : 0;
  const phase = params.daily ? Math.atan2(params.daily.cosine, params.daily.sine) : 0;
  const formula = params.daily
    ? `V(t) = ${a} + ${b} · ${k} · ∫₀ᵗ exp(−${k} · u) · [1 + ${coefficient(amplitude)} · sin(2π · u / 24 + ${coefficient(phase)})] du`
    : params.candidate.kind === 'linear'
    ? `V(t) = ${a} + ${coefficient(params.b / spanHours)} · t`
    : params.candidate.kind === 'logarithmic'
      ? `V(t) = ${a} + ${b} · ln(1 + ${k} · t)`
      : `V(t) = ${a} + ${b} · (1 − exp(−${k} · t))`;
  return {
    ...result, available: true, model: selected.candidate.kind,
    modelLabel: LABELS[selected.candidate.kind], formula,
    originAt: points[0]!.observedAt, rSquared, holdoutMae: holdoutCount ? selected.score : null,
    holdoutPoints: holdoutCount, historyHours: spanHours, warnings, curve,
    predictedViews: Math.round(curve.at(-1)!.views), predictedAt: new Date(endMs).toISOString(),
  };
}
