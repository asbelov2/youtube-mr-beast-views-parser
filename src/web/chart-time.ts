import type { Snapshot } from '../types.js';

export function alignHistory(history: Snapshot[], publishedAt: string, targetPublishedAt: string): Array<{ x: number; y: number }> {
  const shift = Date.parse(targetPublishedAt) - Date.parse(publishedAt);
  return history.filter((p) => Number.isSafeInteger(Number(p.viewCount)) && Number.isFinite(Date.parse(p.observedAt)))
    .map((p) => ({ x: Date.parse(p.observedAt) + shift, y: Number(p.viewCount) }));
}

export function ageLabel(milliseconds: number): string {
  const total = Math.round(milliseconds / 60_000);
  const minutes = Math.abs(total);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const remainder = minutes % 60;
  return `${total < 0 ? '−' : ''}${days ? `${days} д ` : ''}${hours} ч${remainder ? ` ${remainder} мин` : ''}`;
}

export function originalTime(plottedTime: number, sourcePublishedAt: string, targetPublishedAt: string): number {
  return plottedTime + Date.parse(sourcePublishedAt) - Date.parse(targetPublishedAt);
}
