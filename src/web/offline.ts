import { compareDayAgo, compareGrowth, type ModelChoice } from '../analytics.js';
import { fitVideoForecast, readFitWindow } from '../fit-window.js';
import type { OfflineData } from '../dashboard-types.js';

const data = JSON.parse(document.getElementById('offline-data')!.textContent!) as OfflineData;
const banner = document.createElement('div');
banner.className = 'alert';
banner.textContent = `Сохранённая копия на ${new Date(data.index.generatedAt).toLocaleString('ru-RU')}. Сравнение и модели работают локально; новые наблюдения в этот файл не поступают.`;
document.querySelector('.page-heading')!.after(banner);
document.querySelector<HTMLAnchorElement>('.brand')!.href = '#';
document.body.dataset.offline = 'true';
document.getElementById('refresh')!.textContent = 'Пересчитать';
const exportLink = document.querySelector<HTMLAnchorElement>('.export-link')!;
exportLink.href = URL.createObjectURL(new Blob([data.csv], { type: 'text/csv;charset=utf-8' }));
exportLink.download = 'mrbeast-views.csv';

globalThis.fetch = async (input, init) => {
  init?.signal?.throwIfAborted();
  const url = new URL(String(input), 'http://report');
  let body: unknown;
  let status = 200;
  if (url.pathname === '/api/videos') body = data.index;
  else if (url.pathname.startsWith('/api/videos/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/videos/'.length));
    const video = data.index.videos.find((item) => item.id === id);
    if (!video) { status = 404; body = { error: 'Видео не найдено.' }; }
    else {
      const history = data.histories[id]!;
      const compareAt = url.searchParams.get('compareAt');
      const requestedAt = compareAt ? new Date(compareAt)
        : new Date(Date.parse(video.lastObservedAt) - Number(url.searchParams.get('compareHours') ?? 24) * 3_600_000);
      const comparison = compareGrowth(history, requestedAt);
      body = {
        video, history, comparison,
        dayComparison: compareDayAgo(history, comparison, data.index.pollIntervalMinutes * 120_000),
        ...fitVideoForecast(history, video.publishedAt, Number(url.searchParams.get('forecastHours') ?? 24),
          (url.searchParams.get('model') ?? 'auto') as ModelChoice, new Date(data.index.generatedAt), readFitWindow(url.searchParams)),
        holidays: data.calendars[id] ?? [],
      };
    }
  } else { status = 404; body = { error: 'Страница не найдена.' }; }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

void import('./app.js');
