import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DAY_MS, RETENTION_WINDOW_MULTIPLIER, type PublicConfig } from './config.js';
import type { OfflineData } from './dashboard-types.js';
import type { Store } from './storage.js';
import { isWithinTrackingWindow } from './types.js';

export async function writeReport(store: Store, config: PublicConfig, output: string, now = new Date()): Promise<void> {
  const assets = resolve('dist/public');
  const [template, css, script, icon] = await Promise.all([
    readFile(resolve(assets, 'index.html'), 'utf8'), readFile(resolve(assets, 'style.css'), 'utf8'),
    readFile(resolve(assets, 'offline.js'), 'utf8'), readFile(resolve(assets, 'favicon.svg')),
  ]);
  const videos = store.listVideos(config.channelId);
  const data: OfflineData = {
    index: {
      videos: videos.map((video) => ({ ...video,
        tracking: isWithinTrackingWindow(video.publishedAt, now, config.trackingWindowMs),
      })),
      generatedAt: now.toISOString(), trackingWindowDays: config.trackingWindowMs / DAY_MS,
      retentionDays: config.trackingWindowMs * RETENTION_WINDOW_MULTIPLIER / DAY_MS,
      pollIntervalMinutes: config.pollIntervalMs / 60_000,
    },
    histories: Object.fromEntries(videos.map((video) => [video.id, store.history(video.id)])),
    csv: [...store.csv()].join(''),
  };
  // Video titles are untrusted text; escape them before embedding JSON in HTML.
  const payload = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  const html = template
    .replace('<link rel="stylesheet" href="/style.css">', `<style>${css}</style>`)
    .replace('href="/favicon.svg"', `href="data:image/svg+xml;base64,${icon.toString('base64')}"`)
    .replace('<script src="/app.js" defer></script>', `<script id="offline-data" type="application/json">${payload}</script>`)
    // Run the standalone application only after its document body has been parsed.
    .replace('</body>', `<script>${script.replaceAll('</script', '<\\/script')}</script></body>`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html, 'utf8');
}
