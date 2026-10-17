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
