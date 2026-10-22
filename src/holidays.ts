import Holidays from 'date-holidays';
import type { HolidayEvent } from './calendar-types.js';
import type { VideoSummary } from './types.js';

const REGIONS = [
  { code: 'US', label: 'США (федеральные)', zone: 'America/New_York' },
  { code: 'CA', label: 'Канада (федеральные)', zone: 'America/Toronto' },
  { code: 'MX', label: 'Мексика', zone: 'America/Mexico_City' },
  { code: 'BR', label: 'Бразилия', zone: 'America/Sao_Paulo' },
  { code: 'IN', label: 'Индия', zone: 'Asia/Kolkata' },
  { code: 'PH', label: 'Филиппины', zone: 'Asia/Manila' },
  { code: 'ID', label: 'Индонезия', zone: 'Asia/Jakarta' },
  { code: 'GB', label: 'Британия (Англия/Уэльс)', zone: 'Europe/London', state: 'ENG' },
  { code: 'EU', label: 'ЕС (общие даты)', zone: 'Europe/Brussels' },
] as const;

const cache = new Map<string, HolidayEvent[]>();
function yearCalendar(year: number): HolidayEvent[] {
  const key = String(year);
  const cached = cache.get(key);
  if (cached) return cached;
  const result: HolidayEvent[] = [];
  for (const region of REGIONS) {
    const options = { languages: ['ru', 'en'], timezone: region.zone, types: ['public', 'bank'] as ('public' | 'bank')[] };
    const calendar = 'state' in region ? new Holidays(region.code, region.state, options)
      : new Holidays(region.code === 'EU' ? 'BE' : region.code, options);
    if (region.code === 'CA') {
      // Federal general holidays; provincial rules differ. The upstream country
      // dataset deliberately includes only the intersection of provincial days.
      calendar.setHoliday('monday before 05-25', { name: 'Victoria Day', type: 'public' });
      calendar.setHoliday('2nd monday in October', { name: 'Thanksgiving', type: 'public' });
      calendar.setHoliday('11-11', { name: 'Remembrance Day', type: 'public' });
      calendar.setHoliday('12-26', { name: 'Boxing Day', type: 'public' });
      calendar.setHoliday('09-30 since 2021', { name: 'National Day for Truth and Reconciliation', type: 'public' });
    }
    for (const holiday of calendar.getHolidays(year)) {
      if (holiday.type !== 'public' && holiday.type !== 'bank') continue;
      if (region.code === 'EU' && !['01-01', '12-25'].includes(holiday.date.slice(5, 10))) continue;
      result.push({
        country: region.code, countryLabel: region.label, name: holiday.name, date: holiday.date.slice(0, 10),
        startAt: holiday.start.toISOString(), endAt: holiday.end.toISOString(), timeZone: region.zone,
        kind: holiday.type, substitute: holiday.substitute ?? false,
      });
    }
  }
  const unique = [...new Map(result.map((h) => [`${h.country}:${h.startAt}:${h.name}`, h])).values()];
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, unique);
  return unique;
}

/** Local-day intervals, including substitute days; no API calls or collector quota. */
export function holidaysBetween(start: number, end: number): HolidayEvent[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  const result: HolidayEvent[] = [];
  // Adjacent years cover local midnight near UTC New Year and substitute days.
  for (let year = new Date(start).getUTCFullYear() - 1; year <= new Date(end).getUTCFullYear() + 1; year++) {
    for (const holiday of yearCalendar(year)) {
      if (Date.parse(holiday.startAt) <= end && Date.parse(holiday.endAt) > start) result.push(holiday);
    }
  }
  return [...new Map(result.map((h) => [`${h.country}:${h.startAt}:${h.name}`, h])).values()]
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.country.localeCompare(b.country));
}

/** Cover the full visible age of any overlay, as well as the forecast horizon. */
export function videoHolidays(video: VideoSummary, availableVideos: VideoSummary[], now: Date): HolidayEvent[] {
  const maxAge = availableVideos.reduce((age, item) => Math.max(age, Date.parse(item.lastObservedAt) - Date.parse(item.publishedAt)), 0);
  const start = Date.parse(video.publishedAt);
  const end = Math.max(Math.max(now.getTime(), Date.parse(video.lastObservedAt)) + 168 * 3_600_000, start + maxAge);
  return holidaysBetween(start, end);
}
