import { Chart, LineController, LineElement, PointElement, LinearScale, Tooltip, type Plugin, type ChartDataset } from 'chart.js';
import type { ModelChoice } from '../analytics.js';
import type { DashboardIndex, DashboardVideo } from '../dashboard-types.js';
import { channelName } from '../channels.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { dailyLines } from './chart-day-tooltip.js';
import { holidayAnnotations } from './chart-holiday-markers.js';
import { ageLabel, alignHistory, originalTime } from './chart-time.js';
import { startWorldClocks } from './world-clocks.js';
import { clearHolidayContext, holidayTooltipLines, holidaysAt, showHolidayContext, showUpcomingHolidays } from './holiday-info.js';

// The package's CommonJS declarations misidentify its ESM default under NodeNext.
Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, zoomPlugin as unknown as Plugin);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const integer = (value: string | number | null) => value === null ? '—' :
  (typeof value === 'string' ? BigInt(value) : Math.round(value)).toLocaleString('ru-RU');
const signed = (value: string | null) => value === null ? '—' : `${BigInt(value) > 0n ? '+' : ''}${integer(value)}`;
const percentage = (value: number) => `${value > 0 ? '+' : ''}${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`;
const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const periodLabel = (hours: number) => ({ 1: '1 час', 2: '2 часа', 3: '3 часа', 4: '4 часа', 6: '6 часов', 8: '8 часов', 12: '12 часов', 24: '24 часа', 48: '2 дня', 72: '3 дня', 96: '4 дня', 168: 'неделю' })[hours] ?? `${hours.toLocaleString('ru-RU')} ч`;
function text(id: string, value: string) { $(id).textContent = value; }
function localInput(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
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
let chartVideoId: string | undefined;
let chartPublishedMs = 0;
let chartHasOverlays = false;
let fitStartDay = 0;
let fitEndDay: number | null = null;
const overlayIds = new Set<string>();
const overlayColors = new Map<string, string>();
let overlayDetails: DashboardVideo[] = [];
let currentVideo: DashboardVideo | undefined;
const includeBankHolidays = () => $<HTMLInputElement>('include-bank-holidays').checked;
const OVERLAY_COLORS = ['#bd9bfa', '#78d6a3', '#f38db3', '#74a9fa', '#ef956b', '#c8d770'];
const overlayColor = (id: string) => overlayColors.get(id) ?? OVERLAY_COLORS[0]!;
const shortTitle = (title: string) => {
  const length = window.innerWidth < 600 ? 24 : 45;
  return title.length > length ? `${title.slice(0, length - 3)}…` : title;
};

function updateChartView(current: Pick<Chart, 'scales' | 'isZoomedOrPanned'>) {
  const scale = current.scales.x;
  if (!scale) return;
  text('chart-view-range', chartHasOverlays ? `${ageLabel(scale.min - chartPublishedMs)} — ${ageLabel(scale.max - chartPublishedMs)} с публикации`
    : `${dateTime(new Date(scale.min).toISOString())} — ${dateTime(new Date(scale.max).toISOString())}`);
  $<HTMLButtonElement>('zoom-reset').disabled = !current.isZoomedOrPanned();
}

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
    const channel = document.createElement('span');
    channel.className = 'video-option-channel'; channel.textContent = channelName(video.channelId);
    const title = document.createElement('span');
    title.className = 'video-option-title'; title.textContent = video.title;
    const published = document.createElement('time');
    published.className = 'video-option-published'; published.dateTime = video.publishedAt;
    published.textContent = `Опубликовано ${dateTime(video.publishedAt)}`;
    const meta = document.createElement('span'); meta.className = 'video-option-meta';
    const views = document.createElement('span'); views.className = 'video-option-views'; views.textContent = integer(video.viewCount);
    const state = document.createElement('span'); state.className = `video-state${video.tracking ? '' : ' archived'}`;
    state.textContent = video.tracking ? 'Сбор идёт' : 'Архив';
    meta.append(views, state); button.append(channel, title, published, meta);
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
  renderOverlayChoices();
  $('empty-state').hidden = index.videos.length > 0;
  $('video-panel').hidden = index.videos.length === 0;
}

function renderOverlayChoices() {
  const main = index?.videos.find((video) => video.id === selectedId);
  const available = index?.videos.filter((video) => main && Date.parse(video.publishedAt) < Date.parse(main.publishedAt)) ?? [];
  for (const id of overlayIds) if (!available.some((video) => video.id === id)) { overlayIds.delete(id); overlayColors.delete(id); }
  const select = $<HTMLSelectElement>('overlay-select');
  select.replaceChildren(new Option(available.length ? 'Выберите видео…' : 'Нет более ранних видео в базе', ''));
  for (const video of available) if (!overlayIds.has(video.id)) {
    select.append(new Option(`${channelName(video.channelId)} · ${dateTime(video.publishedAt)} · ${video.title}`, video.id));
  }
  select.disabled = overlayIds.size >= OVERLAY_COLORS.length || select.options.length === 1;
  $('overlay-selection').replaceChildren(...[...overlayIds].map((id) => {
    const video = available.find((video) => video.id === id)!;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'overlay-chip';
    button.title = video.title; button.setAttribute('aria-label', `Убрать наложение: ${video.title}`);
    const color = document.createElement('i'); color.style.backgroundColor = overlayColor(id);
    const label = document.createElement('span'); label.textContent = video.title;
    const remove = document.createElement('b'); remove.textContent = '×'; remove.setAttribute('aria-hidden', 'true');
    button.append(color, label, remove);
    button.addEventListener('click', () => { overlayIds.delete(id); overlayColors.delete(id); renderOverlayChoices(); void refreshDetail(); });
    return button;
  }));
  text('overlay-note', overlayIds.size
    ? 'Ось X — время с публикации. В подсказке каждого видео показаны его настоящая дата и праздники. До 6 наложений.'
    : 'Можно добавить несколько видео из сохранённой базы. Линии совмещаются по времени с публикации.');
}

function renderChart(data: DashboardVideo) {
  const view = chart && chartVideoId === data.video.id && chart.isZoomedOrPanned()
    ? { x: { min: chart.scales.x!.min, max: chart.scales.x!.max }, y: { min: chart.scales.y!.min, max: chart.scales.y!.max } } : null;
  lastMeasuredMs = Date.parse(data.video.lastObservedAt);
  const measured = alignHistory(data.history, data.video.publishedAt, data.video.publishedAt);
  const curve = data.forecast.curve.map((point) => ({ x: Date.parse(point.time), y: point.views }));
  const sources = [data, data, ...overlayDetails];
  const datasets: ChartDataset<'line', Array<{ x: number; y: number }>>[] = [
    { label: 'Фактические данные', data: measured, borderColor: '#49d9eb', backgroundColor: '#49d9eb', borderWidth: 2.5, pointRadius: measured.length > 60 ? 0 : 3, pointHoverRadius: 5, tension: 0 },
    { label: 'Аппроксимация и прогноз', data: curve, borderColor: '#f5bf63', borderWidth: 2, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 3, tension: 0 },
  ];
  for (const overlay of overlayDetails) datasets.push({
    label: shortTitle(overlay.video.title), data: alignHistory(overlay.history, overlay.video.publishedAt, data.video.publishedAt),
    borderColor: overlayColor(overlay.video.id), backgroundColor: overlayColor(overlay.video.id),
    borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 4, tension: 0,
  });
  const firstMs = Math.min(Date.parse(data.video.firstObservedAt), ...datasets.flatMap((dataset) => dataset.data[0]?.x ?? []));
  const endMs = Math.max(lastMeasuredMs, ...datasets.flatMap((dataset) => dataset.data.at(-1)?.x ?? []));
  const publishedMs = Date.parse(data.video.publishedAt);
  chartPublishedMs = publishedMs; chartHasOverlays = overlayDetails.length > 0;
  // Use the observation/forecast extent rather than rounding Unix timestamps.
  const timeRange = firstMs === endMs
    ? { min: firstMs - 30 * 60_000, max: firstMs + 30 * 60_000 } : { min: firstMs, max: endMs };
  chart?.destroy();
  clearHolidayContext();
  chart = new Chart($<HTMLCanvasElement>('views-chart'), {
    type: 'line',
    data: { datasets },
    plugins: [cutoffPlugin, dailyLines(data, (index?.pollIntervalMinutes ?? 5) * 120_000),
      holidayAnnotations([
        { id: data.video.id, title: data.video.title, publishedAt: data.video.publishedAt, holidays: data.holidays, color: '#c7b1ed' },
        ...overlayDetails.map((overlay) => ({ id: overlay.video.id, title: overlay.video.title,
          publishedAt: overlay.video.publishedAt, holidays: overlay.holidays, color: overlayColor(overlay.video.id),
          startAt: Date.parse(overlay.video.firstObservedAt), endAt: Date.parse(overlay.video.lastObservedAt) })),
      ], data.video.publishedAt, includeBankHolidays)],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: { type: 'linear', ...timeRange, grid: { color: '#23304755' }, border: { display: false }, ticks: {
          color: '#788ca9', maxTicksLimit: 7, maxRotation: 0, font: { size: 10 },
          callback: (value) => overlayDetails.length ? ageLabel(Number(value) - publishedMs)
            : new Date(Number(value)).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
        } },
        y: { grid: { color: '#23304788' }, border: { display: false }, ticks: {
          color: '#788ca9', font: { size: 10 }, maxTicksLimit: 6,
          callback: (value) => Number(value).toLocaleString('ru-RU', { notation: 'compact', maximumFractionDigits: 2 }),
        } },
      },
      plugins: {
        zoom: {
          limits: { x: { min: 'original', max: 'original', minRange: 60_000 }, y: { min: 'original', max: 'original', minRange: 1 } },
          pan: { enabled: true, mode: 'xy', onPan: ({ chart }) => updateChartView(chart) },
          zoom: {
            mode: 'xy', wheel: { enabled: true, modifierKey: 'ctrl' }, pinch: { enabled: true },
            onZoom: ({ chart }) => updateChartView(chart),
          },
        },
        tooltip: {
        backgroundColor: '#0a1220', borderColor: '#364763', borderWidth: 1, padding: 12,
        titleColor: '#b7c8df', bodyColor: '#dce7f3',
        callbacks: {
          title: (items) => {
            const item = items[0]; if (!item) return '';
            const source = sources[item.datasetIndex]!;
            const time = originalTime(item.parsed.x!, source.video.publishedAt, data.video.publishedAt);
            return [dateTime(new Date(time).toISOString()), `С публикации: ${ageLabel(item.parsed.x! - publishedMs)}`];
          },
          label: (item) => `${shortTitle(item.dataset.label ?? '')}: ${integer(item.parsed.y)}`,
          afterBody: (items) => {
            const item = items[0]; if (!item) return [];
            const source = sources[item.datasetIndex]!;
            const time = originalTime(item.parsed.x!, source.video.publishedAt, data.video.publishedAt);
            const holidays = holidaysAt(source.holidays, time);
            showHolidayContext(holidays, time, source.video.title);
            return holidayTooltipLines(holidays, window.innerWidth < 600 ? 30 : 44);
          },
        },
      } },
    },
  });
  chartVideoId = data.video.id;
  if (view) {
    chart.zoomScale('x', view.x, 'none'); chart.zoomScale('y', view.y, 'none');
  }
  updateChartView(chart);
}

function renderVideo(data: DashboardVideo) {
  currentVideo = data;
  renderUpcomingHolidays();
  const { video, comparison, dayComparison, forecast } = data;
  const tracking = index?.videos.find((item) => item.id === video.id)?.tracking ?? false;
  text('video-title', video.title);
  text('tracking-status', tracking ? 'ОТСЛЕЖИВАЕТСЯ' : 'СБОР ЗАВЕРШЁН');
  $('tracking-status').classList.toggle('archived', !tracking);
  text('video-meta', `${channelName(video.channelId)} · Опубликовано ${dateTime(video.publishedAt)} · ${video.observations} наблюдений`);
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
  text('growth-day-comparison', dayComparison.available
    ? `Вчера за тот же интервал: ${signed(dayComparison.viewDelta)} · ${dayComparison.viewDeltaChangePercent === null ? 'Процент сравнения недоступен' : `${percentage(dayComparison.viewDeltaChangePercent)} к вчерашнему приросту`}`
    : dayComparison.reason ?? 'Нет сравнения со вчера');
  text('rate-day-comparison', dayComparison.available
    ? `Вчера: ${dayComparison.viewsPerHour === null ? '—' : integer(dayComparison.viewsPerHour)} / ч · ${dayComparison.rateChangePercent === null ? 'Процент сравнения недоступен' : `${percentage(dayComparison.rateChangePercent)} к вчерашней скорости`}`
    : dayComparison.reason ?? 'Нет сравнения со вчера');
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
  text('formula-origin', `t — часы с начала выбранных данных (${dateTime(forecast.originAt ?? video.firstObservedAt)}).`);
  text('fit-range-info', data.fitRange.firstObservedAt && data.fitRange.lastObservedAt
    ? `В расчёте: ${data.fitRange.observations} замеров · ${dateTime(data.fitRange.firstObservedAt)} — ${dateTime(data.fitRange.lastObservedAt)}. Полная фактическая история остаётся на графике.`
    : 'В выбранном участке пока нет замеров. Измените границы или дождитесь данных.');
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
    const yesterday = document.createElement('p');
    yesterday.textContent = dayComparison.available
      ? `Тот же интервал сутками раньше, по фактическим замерам: ${dateTime(dayComparison.referenceAt!)} — ${dateTime(dayComparison.currentAt!)}. Скорости сравниваются с учётом длительности обоих интервалов.`
      : dayComparison.reason;
    result.append(yesterday);
  } else {
    const p = document.createElement('p'); p.className = 'comparison-unavailable'; p.textContent = comparison.reason;
    const hint = document.createElement('p'); hint.textContent = `Доступная история: с ${dateTime(video.firstObservedAt)}. Выберите время внутри этого периода или дождитесь новых наблюдений.`;
    result.append(p, hint);
  }
  const input = $<HTMLInputElement>('compare-date');
  input.max = localInput(video.lastObservedAt);
  if (!input.value) input.value = localInput(new Date(Math.min(Date.parse(video.lastObservedAt), Math.ceil(Date.parse(video.firstObservedAt) / 60_000) * 60_000)).toISOString());
  text('observations-count', String(video.observations));
  $('observations').replaceChildren(...data.history.slice(-100).reverse().map((point) => {
    const row = document.createElement('tr');
    const time = document.createElement('td'); time.textContent = dateTime(point.observedAt);
    const views = document.createElement('td'); views.textContent = integer(point.viewCount);
    row.append(time, views); return row;
  }));
  renderChart(data);
}

function renderUpcomingHolidays() {
  if (currentVideo) showUpcomingHolidays(currentVideo.holidays, Date.parse(index!.generatedAt), includeBankHolidays(), document.body.dataset.offline === 'true');
}

async function refreshDetail() {
  if (!selectedId) return;
  detailAbort?.abort(); const controller = new AbortController(); detailAbort = controller;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
  const params = new URLSearchParams({ forecastHours: String(forecastHours), model });
  params.set('fitStartDay', String(fitStartDay));
  if (fitEndDay !== null) params.set('fitEndDay', String(fitEndDay));
  if (compareAt) params.set('compareAt', compareAt); else params.set('compareHours', String(compareHours));
  try {
    const primary = request<DashboardVideo>(`/api/videos/${encodeURIComponent(selectedId)}?${params}`, signal);
    const overlayRequests = Promise.allSettled([...overlayIds].map((id) => request<DashboardVideo>(`/api/videos/${encodeURIComponent(id)}?model=linear&forecastHours=1`, signal)));
    const data = await primary;
    const overlays = await overlayRequests;
    signal.throwIfAborted();
    overlayDetails = overlays.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failed = overlays.filter((result) => result.status === 'rejected').length;
    $('overlay-error').hidden = failed === 0;
    text('overlay-error', `Не удалось загрузить наложений: ${failed}. Нажмите «Обновить данные», чтобы повторить.`);
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
$('zoom-in').addEventListener('click', () => { chart?.zoom(1.3); if (chart) updateChartView(chart); });
$('zoom-out').addEventListener('click', () => { chart?.zoom(1 / 1.3); if (chart) updateChartView(chart); });
function resetChartZoom() { chart?.resetZoom('none'); if (chart) updateChartView(chart); }
$('zoom-reset').addEventListener('click', resetChartZoom);
$('views-chart').addEventListener('dblclick', resetChartZoom);
function selectInterval(hours: number) {
  compareHours = hours; compareAt = null;
  $<HTMLInputElement>('compare-hours').value = String(hours);
  for (const option of $('periods').querySelectorAll<HTMLButtonElement>('button[data-hours]')) {
    const selected = Number(option.dataset.hours) === hours;
    option.classList.toggle('selected', selected); option.setAttribute('aria-pressed', String(selected));
  }
  void refreshDetail();
}
$('periods').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-hours]');
  if (!button) return;
  selectInterval(Number(button.dataset.hours));
});
$('interval-comparison').addEventListener('submit', (event) => {
  event.preventDefault();
  const hours = $<HTMLInputElement>('compare-hours').valueAsNumber;
  if (Number.isFinite(hours) && hours > 0 && hours <= 168) selectInterval(hours);
});
$('custom-comparison').addEventListener('submit', (event) => {
  event.preventDefault();
  const date = new Date($<HTMLInputElement>('compare-date').value);
  if (!Number.isFinite(date.getTime())) return;
  date.setSeconds(0, 0);
  compareAt = date.toISOString();
  for (const option of $('periods').querySelectorAll('button')) { option.classList.remove('selected'); option.setAttribute('aria-pressed', 'false'); }
  void refreshDetail();
});
$('forecast-horizon').addEventListener('change', () => {
  forecastHours = Number($<HTMLSelectElement>('forecast-horizon').value); void refreshDetail();
});
$('include-bank-holidays').addEventListener('change', () => { renderUpcomingHolidays(); chart?.update('none'); });
$('model').addEventListener('change', () => {
  model = $<HTMLSelectElement>('model').value as ModelChoice; void refreshDetail();
});
$('overlay-select').addEventListener('change', () => {
  const id = $<HTMLSelectElement>('overlay-select').value;
  if (!id || overlayIds.size >= OVERLAY_COLORS.length) return;
  overlayColors.set(id, OVERLAY_COLORS.find((color) => ![...overlayColors.values()].includes(color))!);
  overlayIds.add(id); renderOverlayChoices(); void refreshDetail();
});
$('fit-window-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const start = $<HTMLInputElement>('fit-start-day');
  const end = $<HTMLInputElement>('fit-end-day');
  end.setCustomValidity('');
  if (end.value !== '' && end.valueAsNumber <= start.valueAsNumber) {
    end.setCustomValidity('Конец должен быть позже начала.'); end.reportValidity(); return;
  }
  fitStartDay = start.valueAsNumber; fitEndDay = end.value === '' ? null : end.valueAsNumber;
  void refreshDetail();
});
$('fit-end-day').addEventListener('input', () => $<HTMLInputElement>('fit-end-day').setCustomValidity(''));
$('fit-start-day').addEventListener('input', () => $<HTMLInputElement>('fit-end-day').setCustomValidity(''));
$('fit-reset').addEventListener('click', () => {
  fitStartDay = 0; fitEndDay = null;
  $<HTMLInputElement>('fit-start-day').value = '0'; $<HTMLInputElement>('fit-end-day').value = '';
  $<HTMLInputElement>('fit-end-day').setCustomValidity(''); void refreshDetail();
});
startWorldClocks($('world-clocks'));
void refreshIndex();
if (document.body.dataset.offline !== 'true') setInterval(() => void refreshIndex(), 60_000);
