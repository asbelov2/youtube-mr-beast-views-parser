import type { Plugin } from 'chart.js';
import { clusterHolidayMarkers, holidayMarkers, type HolidayMarkerCluster, type HolidayMarkerSource } from './holiday-markers.js';
import { holidayItem, holidayName } from './holiday-info.js';

/** DOM badges keep holiday annotations keyboard accessible and work on touch.
 * They sit above the canvas, so day-line and point hit tests cannot steal them.
 */
export function holidayAnnotations(sources: HolidayMarkerSource[], targetPublishedAt: string,
  includeBank: () => boolean): Plugin<'line'> {
  const layer = document.getElementById('holiday-markers')!;
  const tooltip = document.getElementById('holiday-marker-tooltip')!;
  const parent = layer.parentElement!;
  let signature = '';
  let active: HTMLButtonElement | undefined;
  const hide = () => { tooltip.hidden = true; active?.setAttribute('aria-expanded', 'false'); active = undefined; };
  const outside = (event: Event) => {
    if (!(event.target instanceof Node) || !layer.contains(event.target)) hide();
  };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);

  return {
    id: 'holiday-annotations',
    beforeUpdate: hide,
    afterDestroy() {
      hide(); layer.replaceChildren();
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    },
    afterDraw(current) {
      const scale = current.scales.x;
      if (!scale) return;
      const { chartArea, canvas } = current;
      const bank = includeBank();
      const marks = holidayMarkers(sources, targetPublishedAt, scale.min, scale.max, bank);
      const clusters = clusterHolidayMarkers(marks, (time) => scale.getPixelForValue(time), chartArea.left + 14, chartArea.right - 14);
      const top = canvas.offsetTop + chartArea.top + 19;
      const next = JSON.stringify([bank, top, ...clusters.map((cluster) => [cluster.x, cluster.marks.map((mark) => mark.key)])]);
      if (next === signature) return;
      signature = next; hide();
      layer.replaceChildren(...clusters.map((cluster) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'holiday-marker';
        button.textContent = '!';
        const sourceIds = new Set(cluster.marks.map((mark) => mark.source.id));
        button.style.setProperty('--marker-color', sourceIds.size === 1 ? cluster.marks[0]!.source.color : '#c7b1ed');
        button.style.left = `${canvas.offsetLeft + cluster.x - 14}px`; button.style.top = `${top}px`;
        button.dataset.sources = [...sourceIds].join(',');
        button.dataset.dates = [...new Set(cluster.marks.flatMap((mark) => mark.events.map((event) => event.date)))].join(',');
        button.setAttribute('aria-label', `Праздничные выходные: ${cluster.marks.flatMap((mark) => mark.events.map((event) =>
          `${event.date}, ${event.countryLabel}: ${holidayName(event)}; ${mark.source.title}`)).join('. ')}`);
        button.setAttribute('aria-controls', tooltip.id); button.setAttribute('aria-expanded', 'false');
        const show = () => {
          hide(); active = button; button.setAttribute('aria-expanded', 'true');
          document.getElementById('publication-day-tooltip')!.hidden = true;
          current.setActiveElements([]);
          current.tooltip?.setActiveElements([], { x: cluster.x, y: chartArea.top });
          renderTooltip(cluster);
          tooltip.hidden = false;
          tooltip.style.left = `${Math.max(8, Math.min(canvas.offsetLeft + cluster.x + 14, parent.clientWidth - tooltip.offsetWidth - 8))}px`;
          tooltip.style.top = `${Math.max(8, Math.min(top + 32, parent.clientHeight - tooltip.offsetHeight - 8))}px`;
          const panel = document.getElementById('holiday-list')!;
          document.getElementById('holiday-date')!.textContent = 'Праздники у выбранной отметки «!» · местные даты';
          panel.replaceChildren(...holidayDetails(cluster));
          current.draw();
        };
        button.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'touch') show(); });
        button.addEventListener('pointerleave', () => { if (document.activeElement !== button) hide(); });
        button.addEventListener('focus', show);
        button.addEventListener('blur', hide);
        button.addEventListener('click', show);
        return button;
      }));
    },
  };

  function holidayDetails(cluster: HolidayMarkerCluster): HTMLElement[] {
    return sources.flatMap((source) => {
      const marks = cluster.marks.filter((mark) => mark.source.id === source.id);
      if (!marks.length) return [];
      const heading = document.createElement('p'); heading.className = 'holiday-source'; heading.textContent = source.title;
      heading.style.color = source.color;
      return [heading, ...marks.flatMap((mark) => mark.events.map(holidayItem))];
    });
  }

  function renderTooltip(cluster: HolidayMarkerCluster) {
    const title = document.createElement('strong'); title.textContent = '! Праздничные выходные';
    const detail = holidayDetails(cluster);
    tooltip.replaceChildren(title, ...detail.slice(0, 5));
    if (detail.length > 5) {
      const more = document.createElement('p'); more.className = 'muted'; more.textContent = 'Полный список — в колонке праздников.'; tooltip.append(more);
    }
  }
}
