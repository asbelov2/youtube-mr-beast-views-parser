import type { Plugin } from 'chart.js';
import type { DashboardVideo } from '../dashboard-types.js';
import { createDayViewLookup, publicationDays } from './chart-days.js';
import { holidayTooltipLines, holidaysAt, showHolidayContext } from './holiday-info.js';

export function dailyLines(data: DashboardVideo, maxSampleGapMs: number): Plugin<'line'> {
  const tooltip = document.getElementById('publication-day-tooltip')!;
  const lookup = createDayViewLookup(data.history, data.forecast.curve, maxSampleGapMs);
  let activeTime: number | null = null;
  const hide = () => { activeTime = null; tooltip.hidden = true; };
  const row = (text: string, className: string) => {
    const node = document.createElement('p'); node.className = className; node.textContent = text; return node;
  };
  return {
    id: 'publication-days',
    beforeUpdate: hide,
    afterDestroy: hide,
    afterEvent(current, args) {
      const { event } = args;
      const scale = current.scales.x;
      const previousTime = activeTime;
      const overlaidPoint = current.getActiveElements().some(({ datasetIndex, element }) => datasetIndex >= 2 &&
        event.x !== null && event.y !== null && Math.hypot(element.x - event.x, element.y - event.y) <= 8);
      const mark = args.inChartArea && !overlaidPoint && event.type !== 'mouseout' && event.x !== null && scale && !current.isZoomingOrPanning()
        ? publicationDays(data.video.publishedAt, scale.min, scale.max)
          .map((mark) => ({ ...mark, distance: Math.abs(scale.getPixelForValue(mark.time) - event.x!) }))
          .filter((mark) => mark.distance <= 8).sort((a, b) => a.distance - b.distance)[0]
        : undefined;
      if (mark && event.x !== null && event.y !== null) {
        if (activeTime !== mark.time) {
          const values = lookup(mark.time);
          const title = document.createElement('strong');
          title.textContent = `${mark.day} сут. с публикации`;
          const time = new Date(mark.time).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
          });
          const actual = values.actual
            ? `${values.actual.interpolated ? 'Между замерами ≈' : 'Фактические данные:'} ${BigInt(values.actual.views).toLocaleString('ru-RU')} просмотров`
            : `Фактические данные: ${values.future ? 'ещё нет замера' : 'нет близких замеров'}`;
          const model = values.model === null ? 'Модель: нет данных'
            : `${values.future ? 'Прогноз' : 'Аппроксимация'} ≈ ${Math.round(values.model).toLocaleString('ru-RU')} просмотров`;
          tooltip.replaceChildren(title, row(time, 'day-tooltip-time'), row(actual, values.actual ? 'cyan' : 'day-tooltip-time'), row(model, 'amber'));
          const holidayLines = holidayTooltipLines(holidaysAt(data.holidays, mark.time), window.innerWidth < 600 ? 28 : 40);
          for (const line of holidayLines.slice(0, 6)) {
            tooltip.append(row(line, 'day-tooltip-holiday'));
          }
          if (holidayLines.length > 6) tooltip.append(row('Полный список — рядом с графиком.', 'day-tooltip-holiday'));
          tooltip.dataset.time = String(mark.time);
          activeTime = mark.time;
        }
        tooltip.hidden = false;
        const parent = tooltip.parentElement!;
        const x = current.canvas.offsetLeft + event.x;
        const y = current.canvas.offsetTop + event.y;
        tooltip.style.left = `${Math.max(8, Math.min(x + 12, parent.clientWidth - tooltip.offsetWidth - 8))}px`;
        tooltip.style.top = `${Math.max(8, Math.min(y + 12, parent.clientHeight - tooltip.offsetHeight - 8))}px`;
        // Suppress the nearest point's highlight/tooltip: the boundary has its own
        // exact timestamp and may lie between the actual samples.
        current.setActiveElements([]);
        current.tooltip?.setActiveElements([], { x: event.x, y: event.y });
        showHolidayContext(holidaysAt(data.holidays, mark.time), mark.time, data.video.title);
        args.changed = true;
      } else hide();
      if (previousTime !== activeTime) args.changed = true;
    },
    beforeDatasetsDraw(current) {
      const xScale = current.scales.x;
      if (!xScale) return;
      const { ctx, chartArea } = current;
      ctx.save();
      ctx.beginPath(); ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height); ctx.clip();
      ctx.strokeStyle = '#ef6464'; ctx.fillStyle = '#ef8585'; ctx.font = '10px sans-serif';
      ctx.setLineDash([5, 5]);
      let lastLabelX = -Infinity;
      for (const mark of publicationDays(data.video.publishedAt, xScale.min, xScale.max)) {
        const x = xScale.getPixelForValue(mark.time);
        ctx.lineWidth = mark.time === activeTime ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        if (x - lastLabelX >= 48) {
          const label = `${mark.day} сут.`;
          const fitsRight = x + ctx.measureText(label).width + 4 < chartArea.right;
          ctx.textAlign = fitsRight ? 'left' : 'right';
          ctx.fillText(label, x + (fitsRight ? 4 : -4), chartArea.top + 12); lastLabelX = x;
        }
      }
      ctx.restore();
    },
  };
}
