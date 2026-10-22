export const CLOCK_ZONES = [
  { label: 'Лос-Анджелес', zone: 'America/Los_Angeles' },
  { label: 'Нью-Йорк', zone: 'America/New_York' },
  { label: 'Бразилия · Бразилиа', zone: 'America/Sao_Paulo' },
  { label: 'Центральная Европа', zone: 'Europe/Berlin' },
  { label: 'Индонезия · Джакарта', zone: 'Asia/Jakarta' },
  { label: 'Филиппины · Манила', zone: 'Asia/Manila' },
  { label: 'Индия · Нью-Дели', zone: 'Asia/Kolkata' },
] as const;

export function clockValue(date: Date, zone: string) {
  return {
    time: date.toLocaleTimeString('ru-RU', { timeZone: zone, hourCycle: 'h23' }),
    date: date.toLocaleDateString('ru-RU', { timeZone: zone, day: '2-digit', month: '2-digit', weekday: 'short' }),
    offset: new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(date)
      .find((part) => part.type === 'timeZoneName')!.value.replace('GMT', 'UTC'),
  };
}

export function startWorldClocks(container: HTMLElement) {
  const rows = CLOCK_ZONES.map((clock) => {
    const row = document.createElement('div'); row.className = 'world-clock';
    const name = document.createElement('span'); name.textContent = clock.label;
    const time = document.createElement('time');
    const caption = document.createElement('small');
    row.append(name, time, caption); container.append(row);
    return { ...clock, time, caption };
  });
  const update = () => {
    const now = new Date();
    for (const row of rows) {
      const value = clockValue(now, row.zone);
      row.time.dateTime = now.toISOString(); row.time.textContent = value.time;
      row.caption.textContent = `${value.date} · ${value.offset}`;
    }
  };
  update();
  return setInterval(update, 1000);
}
