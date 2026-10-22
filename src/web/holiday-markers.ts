import type { HolidayEvent } from '../calendar-types.js';

export interface HolidayMarkerSource {
  id: string;
  title: string;
  publishedAt: string;
  holidays: HolidayEvent[];
  color: string;
  /** Optional actual-history bounds, in the source video's original time. */
  startAt?: number;
  endAt?: number;
}

export interface HolidayMarker {
  key: string;
  source: HolidayMarkerSource;
  events: HolidayEvent[];
  time: number;
  originalTime: number;
}

/** Mark the middle of each local day, clipping days at the viewport edges.
 * Overlay dates shift by the publication offset, exactly like their view curves.
 */
export function holidayMarkers(sources: HolidayMarkerSource[], targetPublishedAt: string,
  min: number, max: number, includeBank = false): HolidayMarker[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return [];
  const result: HolidayMarker[] = [];
  for (const source of sources) {
    const shift = Date.parse(targetPublishedAt) - Date.parse(source.publishedAt);
    const groups = new Map<string, HolidayMarker>();
    for (const event of source.holidays) {
      if (event.kind !== 'public' && !(includeBank && event.kind === 'bank')) continue;
      const start = Date.parse(event.startAt);
      const end = Date.parse(event.endAt);
      const left = Math.max(start + shift, min, (source.startAt ?? -Infinity) + shift);
      const right = Math.min(end + shift, max, (source.endAt ?? Infinity) + shift);
      if (!(end > start) || right <= left) continue;
      const key = `${source.id}:${event.country}:${event.startAt}:${event.endAt}`;
      const existing = groups.get(key);
      if (existing) existing.events.push(event);
      else {
        const time = Math.max(left, Math.min((start + end) / 2 + shift, right));
        groups.set(key, { key, source, events: [event], time, originalTime: time - shift });
      }
    }
    result.push(...groups.values());
  }
  return result.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
}

export interface HolidayMarkerCluster { x: number; marks: HolidayMarker[] }

/** Cluster nearby badges without losing their countries or original dates. */
export function clusterHolidayMarkers(marks: HolidayMarker[], pixel: (time: number) => number,
  minX: number, maxX: number, spacing = 30): HolidayMarkerCluster[] {
  const result: HolidayMarkerCluster[] = [];
  for (const mark of marks) {
    const x = Math.max(minX, Math.min(pixel(mark.time), maxX));
    if (!Number.isFinite(x)) continue;
    const last = result.at(-1);
    if (last && x - last.x < spacing) last.marks.push(mark);
    else result.push({ x, marks: [mark] });
  }
  return result;
}
