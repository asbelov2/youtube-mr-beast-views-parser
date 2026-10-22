import type { HolidayEvent } from '../calendar-types.js';

const NAMES: Record<string, string> = {
  'Independence Day': 'День независимости', 'Republic Day': 'День республики', 'Gandhi Jayanti': 'День рождения Махатмы Ганди',
  'Labour Day': 'День труда', 'Thanksgiving': 'День благодарения', 'Thanksgiving Day': 'День благодарения',
  'Good Friday': 'Страстная пятница', 'Easter Monday': 'Пасхальный понедельник', 'Carnival': 'Карнавал',
};
export function holidaysAt(calendar: HolidayEvent[], time: number): HolidayEvent[] {
  return calendar.filter((holiday) => Date.parse(holiday.startAt) <= time && time < Date.parse(holiday.endAt));
}
export function holidayName(holiday: HolidayEvent): string {
  return `${NAMES[holiday.name] ?? holiday.name}${holiday.kind === 'bank' ? ' · банковский выходной' : ''}${holiday.substitute ? ' · перенос выходного' : ''}`;
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
  list.replaceChildren(...events.map((event) => {
    const item = document.createElement('div'); item.className = 'holiday-item';
    const country = document.createElement('strong'); country.textContent = event.countryLabel;
    const name = document.createElement('span'); name.textContent = holidayName(event);
    const date = document.createElement('small'); date.textContent = event.date;
    item.append(country, name, date); return item;
  }));
  if (!events.length) list.textContent = 'В календаре нет праздников на это время.';
}

export function clearHolidayContext() {
  const caption = document.getElementById('holiday-date');
  const list = document.getElementById('holiday-list');
  if (caption) caption.textContent = 'Наведите на точку графика или суточную линию.';
  if (list) list.replaceChildren();
}
