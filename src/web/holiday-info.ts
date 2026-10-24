import type { HolidayEvent } from '../calendar-types.js';
import { UPCOMING_HOLIDAY_DAYS } from '../calendar-types.js';

const NAMES: Record<string, string> = {
  'Independence Day': 'День независимости', 'Republic Day': 'День республики', 'Gandhi Jayanti': 'День рождения Махатмы Ганди',
  'Labour Day': 'День труда', 'Thanksgiving': 'День благодарения', 'Thanksgiving Day': 'День благодарения',
  'Good Friday': 'Страстная пятница', 'Easter Monday': 'Пасхальный понедельник', 'Carnival': 'Карнавал',
};
export function holidaysAt(calendar: HolidayEvent[], time: number): HolidayEvent[] {
  return calendar.filter((holiday) => !isWeekendHoliday(holiday) && Date.parse(holiday.startAt) <= time && time < Date.parse(holiday.endAt));
}

/** Use the country's calendar date, never the browser's weekday or plotted age. */
export function isWeekendHoliday(holiday: HolidayEvent): boolean {
  const day = new Date(`${holiday.date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}
export function holidayName(holiday: HolidayEvent): string {
  return `${NAMES[holiday.name] ?? holiday.name}${holiday.kind === 'bank' ? ' · банковский выходной' : ''}${holiday.substitute ? ' · перенос выходного' : ''}`;
}

/** Include ongoing days off, but never completed days or observances. */
export function upcomingHolidays(calendar: HolidayEvent[], asOf: number, includeBank = false): HolidayEvent[] {
  const end = asOf + UPCOMING_HOLIDAY_DAYS * 86_400_000;
  return calendar.filter((event) => (event.kind === 'public' || includeBank && event.kind === 'bank') &&
    Date.parse(event.endAt) > asOf && Date.parse(event.startAt) < end)
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.countryLabel.localeCompare(b.countryLabel, 'ru'));
}

export function showUpcomingHolidays(calendar: HolidayEvent[], asOf: number, includeBank: boolean, offline: boolean) {
  const list = document.getElementById('upcoming-holiday-list')!;
  document.getElementById('upcoming-holiday-range')!.textContent =
    `${offline ? 'Снимок на' : 'С'} ${new Date(asOf).toLocaleDateString('ru-RU')} · ${UPCOMING_HOLIDAY_DAYS} дней вперёд. Даты — местные.`;
  list.replaceChildren(...upcomingHolidays(calendar, asOf, includeBank).map((event) => {
    const item = holidayItem(event);
    item.dataset.kind = event.kind;
    item.dataset.date = event.date;
    if (Date.parse(event.startAt) <= asOf) {
      const badge = document.createElement('small'); badge.className = 'holiday-ongoing'; badge.textContent = 'Сейчас';
      item.prepend(badge);
    }
    return item;
  }));
  if (!list.children.length) list.textContent = 'В этом периоде нет праздничных выходных из выбранного календаря.';
}

export function holidayItem(event: HolidayEvent): HTMLDivElement {
  const item = document.createElement('div'); item.className = 'holiday-item';
  const country = document.createElement('strong'); country.textContent = event.countryLabel;
  const name = document.createElement('span'); name.textContent = holidayName(event);
  const date = document.createElement('small');
  date.textContent = new Date(`${event.date}T12:00:00Z`).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', weekday: 'short', timeZone: 'UTC',
  });
  item.append(country, name, date); return item;
}

export function holidayTooltipLines(events: HolidayEvent[], width = 42): string[] {
  const groups = new Map<string, string[]>();
  for (const event of events) {
    const name = holidayName(event);
    groups.set(name, [...(groups.get(name) ?? []), event.countryLabel]);
  }
  const lines: string[] = [];
  for (const [name, countries] of groups) {
    const words = `${name} — ${countries.join(', ')}`.split(' ');
    let line = '';
    for (const word of words) {
      if (line && line.length + word.length + 1 > width) { lines.push(line); line = ''; }
      line += (line ? ' ' : '') + word;
    }
    if (line) lines.push(line);
  }
  return lines.length ? ['Праздники по местной дате:', ...lines.slice(0, 12), ...(lines.length > 12 ? ['Полный список — рядом с графиком.'] : [])] : [];
}

export function showHolidayContext(events: HolidayEvent[], time: number, videoTitle: string) {
  const caption = document.getElementById('holiday-date');
  const list = document.getElementById('holiday-list');
  if (!caption || !list) return;
  caption.textContent = `${new Date(time).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })} · ${videoTitle}`;
  list.replaceChildren(...events.map(holidayItem));
  if (!events.length) list.textContent = 'В календаре нет праздников на это время.';
}

export function clearHolidayContext() {
  const caption = document.getElementById('holiday-date');
  const list = document.getElementById('holiday-list');
  if (caption) caption.textContent = 'Наведите на точку, суточную линию или отметку «!».';
  if (list) list.replaceChildren();
}
