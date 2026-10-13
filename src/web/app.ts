import { Chart, LineController, LineElement, PointElement, LinearScale, Tooltip, type Plugin } from 'chart.js';
import type { ModelChoice } from '../analytics.js';
import type { DashboardIndex, DashboardVideo } from '../dashboard-types.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const integer = (value: string | number | null) => value === null ? '—' :
  (typeof value === 'string' ? BigInt(value) : Math.round(value)).toLocaleString('ru-RU');
const signed = (value: string | null) => value === null ? '—' : `${BigInt(value) > 0n ? '+' : ''}${integer(value)}`;
const percentage = (value: number) => `${value > 0 ? '+' : ''}${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`;
const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const periodLabel = (hours: number) => ({ 1: '1 час', 6: '6 часов', 24: '24 часа', 48: '2 дня', 72: '3 дня', 96: '4 дня', 168: 'неделю' })[hours] ?? `${hours} ч`;
function text(id: string, value: string) { $(id).textContent = value; }
function localInput(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}

let index: DashboardIndex | undefined;
let selectedId: string | null = new URL(location.href).searchParams.get('video');
let compareHours = 1;
let compareAt: string | null = null;
let forecastHours = 1;
let model: ModelChoice = 'auto';
let lastMeasuredMs = 0;
let detailAbort: AbortController | undefined;
let refreshing = false;
let chart: Chart<'line', Array<{ x: number; y: number }>> | undefined;

const cutoffPlugin: Plugin<'line'> = {
  id: 'last-observation',
  afterDraw(chart) {
    const x = chart.scales.x?.getPixelForValue(lastMeasuredMs);
    if (x === undefined || x < chart.chartArea.left || x > chart.chartArea.right) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = '#71819a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chart.chartArea.top);
    ctx.lineTo(x, chart.chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

async function request<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(15_000) });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Не удалось загрузить данные.');
  return body;
}

function showError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Не удалось загрузить данные.';
  text('global-error', message);
  $('global-error').hidden = false;
}

function renderList() {
  if (!index) return;
  const list = $('video-list');
  list.replaceChildren();
  for (const video of index.videos) {
    const button = document.createElement('button');
    button.className = `video-option${video.id === selectedId ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(video.id === selectedId));
    const title = document.createElement('span');
    title.className = 'video-option-title'; title.textContent = video.title;
    const meta = document.createElement('span'); meta.className = 'video-option-meta';
    const views = document.createElement('span'); views.className = 'video-option-views'; views.textContent = integer(video.viewCount);
    const state = document.createElement('span'); state.className = `video-state${video.tracking ? '' : ' archived'}`;
    state.textContent = video.tracking ? 'Сбор идёт' : 'Архив';
    meta.append(views, state); button.append(title, meta);
    button.addEventListener('click', () => {
      selectedId = video.id;
      const url = new URL(location.href); url.searchParams.set('video', video.id);
      window.history.replaceState(null, '', url);
      renderList(); void refreshDetail();
    });
    list.append(button);
  }
  text('video-count', String(index.videos.length));
  text('collection-info', `Сбор каждые ${index.pollIntervalMinutes} мин. Видео отслеживаются ${index.trackingWindowDays} дней после публикации.`);
  text('retention-note', `Срок отслеживания: ${index.trackingWindowDays} дней · Хранение: ${index.retentionDays} дней с публикации`);
  $('empty-state').hidden = index.videos.length > 0;
  $('video-panel').hidden = index.videos.length === 0;
}

function renderChart(data: DashboardVideo) {
  lastMeasuredMs = Date.parse(data.video.lastObservedAt);
  const measured = data.history.filter((point) => Number.isSafeInteger(Number(point.viewCount)))
    .map((point) => ({ x: Date.parse(point.observedAt), y: Number(point.viewCount) }));
  const curve = data.forecast.curve.map((point) => ({ x: Date.parse(point.time), y: point.views }));
  chart?.destroy();
  chart = new Chart($<HTMLCanvasElement>('views-chart'), {
    type: 'line',
    data: { datasets: [
      { label: 'Фактические данные', data: measured, borderColor: '#49d9eb', backgroundColor: '#49d9eb', borderWidth: 2.5, pointRadius: measured.length > 60 ? 0 : 3, pointHoverRadius: 5, tension: 0 },
      { label: 'Аппроксимация и прогноз', data: curve, borderColor: '#f5bf63', borderWidth: 2, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 3, tension: 0 },
    ] },
    plugins: [cutoffPlugin],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: { type: 'linear', grid: { color: '#23304755' }, border: { display: false }, ticks: {
          color: '#788ca9', maxTicksLimit: 7, maxRotation: 0, font: { size: 10 },
          callback: (value) => new Date(Number(value)).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
        } },
        y: { grid: { color: '#23304788' }, border: { display: false }, ticks: {
          color: '#788ca9', font: { size: 10 }, maxTicksLimit: 6,
          callback: (value) => Number(value).toLocaleString('ru-RU', { notation: 'compact', maximumFractionDigits: 2 }),
        } },
      },
      plugins: { tooltip: {
        backgroundColor: '#0a1220', borderColor: '#364763', borderWidth: 1, padding: 12,
        titleColor: '#b7c8df', bodyColor: '#dce7f3',
        callbacks: {
          title: (items) => items[0] ? dateTime(new Date(items[0].parsed.x!).toISOString()) : '',
          label: (item) => `${item.dataset.label}: ${integer(item.parsed.y)}`,
        },
      } },
    },
  });
}

function renderVideo(data: DashboardVideo) {
  const { video, comparison, forecast } = data;
  const tracking = index?.videos.find((item) => item.id === video.id)?.tracking ?? false;
  text('video-title', video.title);
  text('tracking-status', tracking ? 'ОТСЛЕЖИВАЕТСЯ' : 'СБОР ЗАВЕРШЁН');
  $('tracking-status').classList.toggle('archived', !tracking);
  text('video-meta', `Опубликовано ${dateTime(video.publishedAt)} · ${video.observations} наблюдений`);
  $<HTMLAnchorElement>('youtube-link').href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
  text('current-views', integer(video.viewCount));
  const stale = tracking && index && Date.now() - Date.parse(video.lastObservedAt) > index.pollIntervalMinutes * 120_000;
  text('last-observed', `${stale ? 'Данные давно не обновлялись · ' : ''}${dateTime(video.lastObservedAt)}`);
  text('growth-label', compareAt ? 'Прирост с выбранного времени' : `Прирост за ${periodLabel(compareHours)}`);
  text('growth-views', signed(comparison.viewDelta));
  text('growth-percent', comparison.available
    ? comparison.percentChange === null ? 'Нулевая база сравнения' : `${percentage(comparison.percentChange)} к базовому числу просмотров`
    : 'Недостаточно истории');
  text('growth-rate', comparison.viewsPerHour === null ? '—' : `${comparison.viewsPerHour > 0 ? '+' : ''}${integer(comparison.viewsPerHour)}`);
  text('growth-change', comparison.growthChangePercent === null
    ? 'Нет сравнимого предыдущего периода'
    : `${percentage(comparison.growthChangePercent)} к предыдущему периоду`);
  text('forecast-label', `Прогноз через ${periodLabel(forecastHours)}`);
  text('forecast-views', integer(forecast.predictedViews));
  text('forecast-date', forecast.predictedAt ? `По модели · ${dateTime(forecast.predictedAt)}` : 'Модель пока недоступна');
  text('history-range', `${dateTime(video.firstObservedAt)} — ${dateTime(video.lastObservedAt)}`);
  $('model-unavailable').hidden = forecast.available;
  text('model-unavailable', forecast.reason ?? '');
  $('forecast-warnings').replaceChildren(...forecast.warnings.map((warning) => {
    const p = document.createElement('p'); p.textContent = warning; return p;
  }));
  $('model-details').hidden = !forecast.available;
  text('model-summary', `Модель: ${forecast.modelLabel ?? '—'} · соответствие данным R² ${forecast.rSquared?.toFixed(3) ?? '—'}`);
  text('model-formula', forecast.formula ?? '');
  text('formula-origin', `t — часы с первого наблюдения (${dateTime(video.firstObservedAt)}).`);
  text('model-quality', forecast.holdoutMae === null ? 'Проверка на отложенных точках пока недоступна.'
    : `Средняя абсолютная ошибка на последних ${forecast.holdoutPoints} точках: ${integer(forecast.holdoutMae)} просмотров. Эти точки не использовались при проверочном обучении.`);
  const result = $('comparison-result'); result.replaceChildren();
  if (comparison.available) {
    const p = document.createElement('p');
    p.textContent = `Базовый замер: ${dateTime(comparison.referenceAt!)} — ${integer(comparison.referenceViewCount)} просмотров. Последний замер: ${dateTime(video.lastObservedAt)}. Выбрано последнее наблюдение не позже указанного времени.`;
    const previous = document.createElement('p');
    previous.textContent = comparison.previousPeriodDelta === null
      ? 'Предыдущий период ещё не полностью представлен в истории.'
      : `Прирост за предыдущий период: ${signed(comparison.previousPeriodDelta)}. Изменение скорости рассчитывается с учётом фактической длины обоих периодов.`;
    result.append(p, previous);
  } else {
    const p = document.createElement('p'); p.className = 'comparison-unavailable'; p.textContent = comparison.reason;
    const hint = document.createElement('p'); hint.textContent = `Доступная история: с ${dateTime(video.firstObservedAt)}. Выберите время внутри этого периода или дождитесь новых наблюдений.`;
    result.append(p, hint);
  }
  const input = $<HTMLInputElement>('compare-date');
  input.max = localInput(video.lastObservedAt);
  if (!input.value) input.value = localInput(video.firstObservedAt);
  text('observations-count', String(video.observations));
  $('observations').replaceChildren(...data.history.slice(-100).reverse().map((point) => {
    const row = document.createElement('tr');
    const time = document.createElement('td'); time.textContent = dateTime(point.observedAt);
    const views = document.createElement('td'); views.textContent = integer(point.viewCount);
    row.append(time, views); return row;
  }));
  renderChart(data);
}

async function refreshDetail() {
  if (!selectedId) return;
  detailAbort?.abort(); detailAbort = new AbortController();
  const params = new URLSearchParams({ forecastHours: String(forecastHours), model });
  if (compareAt) params.set('compareAt', compareAt); else params.set('compareHours', String(compareHours));
  try {
    const data = await request<DashboardVideo>(`/api/videos/${encodeURIComponent(selectedId)}?${params}`, AbortSignal.any([detailAbort.signal, AbortSignal.timeout(15_000)]));
    $('global-error').hidden = true;
    renderVideo(data);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    showError(error);
  }
}

async function refreshIndex() {
  if (refreshing) return;
  refreshing = true; $<HTMLButtonElement>('refresh').disabled = true;
  try {
    index = await request<DashboardIndex>('/api/videos');
    if (!index.videos.some((video) => video.id === selectedId)) selectedId = index.videos[0]?.id ?? null;
    renderList(); await refreshDetail();
    if (!index.videos.length) $('global-error').hidden = true;
  } catch (error) { showError(error); }
  finally { refreshing = false; $<HTMLButtonElement>('refresh').disabled = false; }
}

$('refresh').addEventListener('click', () => void refreshIndex());
$('periods').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-hours]');
  if (!button) return;
  compareHours = Number(button.dataset.hours); compareAt = null;
  for (const option of $('periods').querySelectorAll('button')) {
    const selected = option === button; option.classList.toggle('selected', selected); option.setAttribute('aria-pressed', String(selected));
  }
  void refreshDetail();
});
$('custom-comparison').addEventListener('submit', (event) => {
  event.preventDefault();
  const date = new Date($<HTMLInputElement>('compare-date').value);
  if (!Number.isFinite(date.getTime())) return;
  compareAt = date.toISOString();
  for (const option of $('periods').querySelectorAll('button')) { option.classList.remove('selected'); option.setAttribute('aria-pressed', 'false'); }
  void refreshDetail();
});
$('forecast-horizon').addEventListener('change', () => {
  forecastHours = Number($<HTMLSelectElement>('forecast-horizon').value); void refreshDetail();
});
$('model').addEventListener('change', () => {
  model = $<HTMLSelectElement>('model').value as ModelChoice; void refreshDetail();
});
void refreshIndex();
if (document.body.dataset.offline !== 'true') setInterval(() => void refreshIndex(), 60_000);
