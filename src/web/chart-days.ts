import type { CurvePoint } from '../analytics.js';
import type { Snapshot } from '../types.js';

const DAY_MS = 86_400_000;

/** Visible 24-hour boundaries since publication; publication itself is not a boundary. */
export function publicationDays(publishedAt: string, min: number, max: number): Array<{ time: number; day: number }> {
  const origin = Date.parse(publishedAt);
  if (![origin, min, max].every(Number.isFinite) || min > max) return [];
  const first = Math.max(1, Math.ceil((min - origin) / DAY_MS));
  const last = Math.floor((max - origin) / DAY_MS);
  const result: Array<{ time: number; day: number }> = [];
  for (let day = first; day <= last && result.length < 1000; day++) result.push({ time: origin + day * DAY_MS, day });
  return result;
}

interface Timed { time: number }

function bracket<T extends Timed>(points: T[], time: number): [T, T] | null {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle]!.time <= time) low = middle + 1;
    else high = middle;
  }
  const left = points[low - 1];
  if (left?.time === time) return [left, left];
  const right = points[low];
  return left && right ? [left, right] : null;
}

export interface DayViews {
  actual: { views: string; interpolated: boolean } | null;
  model: number | null;
  future: boolean;
}

/** Index once per chart; hovering never invents observations or crosses a long gap. */
export function createDayViewLookup(history: Snapshot[], curve: CurvePoint[], maxSampleGapMs: number): (time: number) => DayViews {
  const observed = history.map((p) => ({ time: Date.parse(p.observedAt), views: p.viewCount }))
    .filter((p) => Number.isFinite(p.time) && /^\d+$/.test(p.views)).sort((a, b) => a.time - b.time);
  const modeled = curve.map((p) => ({ time: Date.parse(p.time), views: p.views }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.views)).sort((a, b) => a.time - b.time);
  return (time) => {
    const result: DayViews = { actual: null, model: null, future: time > (observed.at(-1)?.time ?? Infinity) };
    if (!Number.isSafeInteger(time)) return result;
    const measurement = bracket(observed, time);
    if (measurement) {
      const [left, right] = measurement;
      const duration = right.time - left.time;
      if (!duration) result.actual = { views: left.views, interpolated: false };
      else if (duration <= maxSampleGapMs) {
        // Exact integer weights preserve large counters; only the estimated
        // result is rounded, without converting the counter to a JS Number.
        const denominator = BigInt(duration);
        const numerator = BigInt(left.views) * BigInt(right.time - time) + BigInt(right.views) * BigInt(time - left.time);
        result.actual = { views: ((numerator + denominator / 2n) / denominator).toString(), interpolated: true };
      }
    }
    const prediction = bracket(modeled, time);
    if (prediction) {
      const [left, right] = prediction;
      result.model = left.time === right.time ? left.views
        : left.views + (right.views - left.views) * (time - left.time) / (right.time - left.time);
    }
    return result;
  };
}
