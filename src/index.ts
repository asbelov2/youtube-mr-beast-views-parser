import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Collector } from './collector.js';
import { channelName } from './channels.js';
import { databasePath, DAY_MS, readConfig, readPublicConfig, RETENTION_WINDOW_MULTIPLIER } from './config.js';
import { runScheduler } from './scheduler.js';
import { createDashboardServer } from './server.js';
import { writeReport } from './report.js';
import { Store } from './storage.js';
import { YouTubeClient } from './youtube.js';

const HELP = `MrBeast view collector (Node.js 24.19+, TypeScript)

Usage:
  npm start                 Start the dashboard and scheduled collector
  npm run web               Start just the dashboard (no API key needed)
  npm run report            Save an interactive standalone HTML report
  npm run collect           Collect once and exit
  npm run --silent export > views.csv  Export saved counts (no API key needed)
  npm start -- --help        Show this help

Settings: .env or environment variables
  YOUTUBE_API_KEY          Required for collection (YouTube Data API v3)
  TRACKING_WINDOW_DAYS     Video age limit, default 14 days
  POLL_INTERVAL_MINUTES    Collection interval, default 5 minutes
  FULL_DISCOVERY_INTERVAL_MINUTES  Full upload scan interval, default 60 minutes
  DATABASE_PATH           Default ./data/mrbeast.sqlite
  YOUTUBE_CHANNEL_IDS     Comma-separated IDs; default MrBeast and MrBeast Gaming
  YOUTUBE_CHANNEL_ID      Legacy single-channel override
  WEB_HOST                Default 127.0.0.1
  WEB_PORT                Default 3000
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args.length > 1 || (args.length === 1 && !['--once', '--export-csv', '--web-only', '--report'].includes(args[0]!))) {
    throw new Error('Unknown arguments. Run npm start -- --help for usage.');
  }
  if (args[0] === '--export-csv') {
    const path = databasePath();
    if (!existsSync(path)) throw new Error('Database does not exist. Collect statistics before exporting.');
    const store = new Store(path);
    try {
      for (const line of store.csv()) {
        if (!process.stdout.write(line)) await once(process.stdout, 'drain');
      }
    } finally {
      store.close();
    }
    return;
  }

  if (args[0] === '--report') {
    const config = readPublicConfig();
    if (!existsSync(config.databasePath)) throw new Error('Database does not exist. Collect statistics before exporting.');
    const store = new Store(config.databasePath);
    try {
      const output = resolve('data/report.html');
      await writeReport(store, config, output);
      console.log(JSON.stringify({ event: 'report_saved', path: output }));
    } finally { store.close(); }
    return;
  }

  const webOnly = args[0] === '--web-only';
  const config = webOnly ? readPublicConfig() : readConfig();
  const store = new Store(config.databasePath);
  const apiKey = 'apiKey' in config && typeof config.apiKey === 'string' ? config.apiKey : '';
  const collectors = config.channelIds.map((channelId) => ({
    channelId,
    collector: new Collector({ ...config, channelId }, new YouTubeClient({ apiKey, channelId }), store),
  }));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const logError = (channelId: string, error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown collection error.';
    console.error(JSON.stringify({
      event: 'collection_failed', channelId, channelName: channelName(channelId), at: new Date().toISOString(),
      message: apiKey ? message.replaceAll(apiKey, '[redacted]') : message,
    }));
  };
  const logResult = (channelId: string, result: Awaited<ReturnType<Collector['collect']>>) => {
    console.log(JSON.stringify({ event: 'collection_completed', channelId, channelName: channelName(channelId), ...result }));
  };

  let server: ReturnType<typeof createDashboardServer> | undefined;
  try {
    if (args[0] === '--once') {
      await Promise.all(collectors.map(async ({ channelId, collector }) => {
        try {
          logResult(channelId, await collector.collect(controller.signal));
        } catch (error) {
          if (!controller.signal.aborted) {
            logError(channelId, error);
            process.exitCode = 1;
          }
        }
      }));
    } else {
      server = createDashboardServer({ store, config });
      server.listen(config.webPort, config.webHost);
      await once(server, 'listening');
      const address = server.address();
      console.log(JSON.stringify({
        event: 'dashboard_started', host: config.webHost,
        port: address && typeof address !== 'string' ? address.port : config.webPort,
      }));
      if (webOnly) {
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      console.log(JSON.stringify({
        event: 'collector_started', channelIds: config.channelIds,
        trackingWindowDays: config.trackingWindowMs / DAY_MS,
        retentionDays: config.trackingWindowMs * RETENTION_WINDOW_MULTIPLIER / DAY_MS,
        pollIntervalMinutes: config.pollIntervalMs / 60_000,
        fullDiscoveryIntervalMinutes: config.fullDiscoveryIntervalMs / 60_000,
        databasePath: config.databasePath,
      }));
      // Each channel has its own discovery state and scheduler: one API failure
      // cannot stop the other channel, and cycles for the same channel never overlap.
      await Promise.all(collectors.map(({ channelId, collector }) => runScheduler({
        intervalMs: config.pollIntervalMs, signal: controller.signal,
        collect: (signal) => collector.collect(signal),
        onResult: (result) => logResult(channelId, result), onError: (error) => logError(channelId, error),
      })));
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    store.close();
  }
}

main().catch((error: unknown) => {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  const message = error instanceof Error ? error.message : 'Application failed.';
  console.error(key ? message.replaceAll(key, '[redacted]') : message);
  process.exitCode = 1;
});
