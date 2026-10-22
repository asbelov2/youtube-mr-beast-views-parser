import { forecastViews, type Forecast, type ModelChoice } from './analytics.js';
import type { Snapshot } from './types.js';

const DAY_MS = 86_400_000;
export interface FitWindow { startDay: number; endDay: number | null }
export interface FitRange extends FitWindow {
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  observations: number;
}

export function readFitWindow(params: URLSearchParams): FitWindow {
  const start = params.get('fitStartDay');
  const end = params.get('fitEndDay');
  const startDay = start === null ? 0 : Number(start);
  const endDay = end === null ? null : Number(end);
  if (start?.trim() === '' || end?.trim() === '' || !Number.isFinite(startDay) || startDay < 0 || startDay > 3650 ||
    (endDay !== null && (!Number.isFinite(endDay) || endDay <= startDay || endDay > 3650))) {
    throw new Error('Участок аппроксимации: начало — от 0 суток, конец — позже начала или «Последний замер» (максимум 3650 суток).');
  }
  return { startDay, endDay };
}

export function fitVideoForecast(history: Snapshot[], publishedAt: string, horizon: number, model: ModelChoice,
  now: Date, window: FitWindow): { forecast: Forecast; fitRange: FitRange } {
  const origin = Date.parse(publishedAt);
  const start = origin + window.startDay * DAY_MS;
  const end = window.endDay === null ? Infinity : origin + window.endDay * DAY_MS;
  const selected = history.filter((point) => {
    const time = Date.parse(point.observedAt);
    return time >= start && time <= end;
  }).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const lastActual = history.reduce((latest, point) => Math.max(latest, Date.parse(point.observedAt)), now.getTime());
  const forecast = forecastViews(selected, horizon, model, new Date(lastActual));
  if (selected.at(-1)?.observedAt !== history.at(-1)?.observedAt) {
    forecast.warnings = forecast.warnings.map((warning) => warning.startsWith('Последнее наблюдение старше часа')
      ? 'Выбранный участок заканчивается раньше последних данных. Более поздние замеры не используются для подбора модели.' : warning);
  }
  return { forecast, fitRange: {
    ...window, firstObservedAt: selected[0]?.observedAt ?? null, lastObservedAt: selected.at(-1)?.observedAt ?? null,
    observations: selected.length,
  } };
}
