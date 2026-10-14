import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { compareGrowth, forecastViews, type ModelChoice } from './analytics.js';
import { DAY_MS, RETENTION_WINDOW_MULTIPLIER, type PublicConfig } from './config.js';
import type { DashboardIndex, DashboardVideo } from './dashboard-types.js';
import type { Store } from './storage.js';
import { isWithinTrackingWindow } from './types.js';

interface ServerOptions {
  store: Store;
  config: PublicConfig;
  webRoot?: string;
  now?: () => Date;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function hours(raw: string | null, fallback: number): number {
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 168) {
    throw new RequestError(400, 'Период должен быть больше нуля и не больше 168 часов.');
  }
  return value;
}

export function createDashboardServer(options: ServerOptions): Server {
  const now = options.now ?? (() => new Date());
  const webRoot = options.webRoot ?? resolve('dist/public');
  const assets: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  };
  return createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Cache-Control', 'no-store');
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const handle = async () => {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        throw new RequestError(405, 'Разрешены только GET-запросы.');
      }
      const url = new URL(request.url ?? '/', 'http://dashboard');
      if (url.pathname === '/api/videos') {
        const current = now();
        const payload: DashboardIndex = {
          videos: options.store.listVideos(options.config.channelIds).map((video) => ({
            ...video, tracking: isWithinTrackingWindow(video.publishedAt, current, options.config.trackingWindowMs),
          })),
          generatedAt: current.toISOString(),
          trackingWindowDays: options.config.trackingWindowMs / DAY_MS,
          retentionDays: options.config.trackingWindowMs * RETENTION_WINDOW_MULTIPLIER / DAY_MS,
          pollIntervalMinutes: options.config.pollIntervalMs / 60_000,
        };
        json(200, payload);
        return;
      }
      if (url.pathname.startsWith('/api/videos/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/videos/'.length));
        const video = options.store.listVideos(options.config.channelIds).find((item) => item.id === id);
        if (!video) throw new RequestError(404, 'Видео не найдено.');
        const history = options.store.history(id);
        const compareAt = url.searchParams.get('compareAt');
        if (compareAt !== null && url.searchParams.has('compareHours')) {
          throw new RequestError(400, 'Выберите период или конкретное время, а не оба сразу.');
        }
        const requestedAt = compareAt !== null
          ? new Date(compareAt)
          : new Date(Date.parse(video.lastObservedAt) - hours(url.searchParams.get('compareHours'), 24) * 3_600_000);
        if (!Number.isFinite(requestedAt.getTime())) throw new RequestError(400, 'Некорректное время сравнения.');
        const model = url.searchParams.get('model') ?? 'auto';
        if (!['auto', 'linear', 'logarithmic', 'saturation'].includes(model)) {
          throw new RequestError(400, 'Неизвестная модель аппроксимации.');
        }
        const payload: DashboardVideo = {
          video, history, comparison: compareGrowth(history, requestedAt),
          forecast: forecastViews(history, hours(url.searchParams.get('forecastHours'), 24), model as ModelChoice, now()),
        };
        json(200, payload);
        return;
      }
      if (url.pathname === '/api/export.csv') {
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="mrbeast-views.csv"',
        });
        for (const line of options.store.csv()) {
          if (response.destroyed) return;
          if (!response.write(line)) await new Promise<void>((resolve) => {
            const done = () => {
              response.removeListener('drain', done); response.removeListener('close', done); resolve();
            };
            response.once('drain', done); response.once('close', done);
          });
        }
        response.end();
        return;
      }
      const asset = assets[url.pathname];
      if (!asset) throw new RequestError(404, 'Страница не найдена.');
      try {
        const content = await readFile(resolve(webRoot, asset[0]));
        response.writeHead(200, { 'Content-Type': asset[1] });
        response.end(content);
      } catch {
        throw new RequestError(503, 'Веб-интерфейс ещё не собран. Выполните npm run build.');
      }
    };
    handle().catch((error: unknown) => {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof RequestError) json(error.status, { error: error.message });
      else json(500, { error: 'Не удалось обработать запрос.' });
    });
  });
}
