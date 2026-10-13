import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { Collector } from './collector.js';
import { databasePath, DAY_MS, readConfig } from './config.js';
import { runScheduler } from './scheduler.js';
import { Store } from './storage.js';
import { YouTubeClient } from './youtube.js';

const HELP = `MrBeast view collector (Node.js 24.19+, TypeScript)

Usage:
  npm start                 Collect now and continue on a schedule
  npm run collect           Collect once and exit
  npm run --silent export > views.csv  Export saved counts (no API key needed)
  npm start -- --help        Show this help

Settings: .env or environment variables
  YOUTUBE_API_KEY          Required for collection (YouTube Data API v3)
  TRACKING_WINDOW_DAYS     Video age limit, default 14 days
  POLL_INTERVAL_MINUTES    Collection interval, default 5 minutes
  FULL_DISCOVERY_INTERVAL_MINUTES  Full upload scan interval, default 60 minutes
  DATABASE_PATH           Default ./data/mrbeast.sqlite
  YOUTUBE_CHANNEL_ID      Default MrBeast's main channel
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args.length > 1 || (args.length === 1 && !['--once', '--export-csv'].includes(args[0]!))) {
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

  const config = readConfig();
  const store = new Store(config.databasePath);
  const youtube = new YouTubeClient({ apiKey: config.apiKey, channelId: config.channelId });
  const collector = new Collector(config, youtube, store);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const logError = (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown collection error.';
    console.error(JSON.stringify({
      event: 'collection_failed', at: new Date().toISOString(),
      message: message.replaceAll(config.apiKey, '[redacted]'),
    }));
  };
  const logResult = (result: Awaited<ReturnType<Collector['collect']>>) => {
    console.log(JSON.stringify({ event: 'collection_completed', ...result }));
  };

  try {
    if (args[0] === '--once') {
      try {
        logResult(await collector.collect(controller.signal));
      } catch (error) {
        if (!controller.signal.aborted) {
          logError(error);
          process.exitCode = 1;
        }
      }
    } else {
      console.log(JSON.stringify({
        event: 'collector_started', channelId: config.channelId,
        trackingWindowDays: config.trackingWindowMs / DAY_MS,
        pollIntervalMinutes: config.pollIntervalMs / 60_000,
        fullDiscoveryIntervalMinutes: config.fullDiscoveryIntervalMs / 60_000,
        databasePath: config.databasePath,
      }));
      await runScheduler({
        intervalMs: config.pollIntervalMs, signal: controller.signal,
        collect: (signal) => collector.collect(signal), onResult: logResult, onError: logError,
      });
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    store.close();
  }
}

main().catch((error: unknown) => {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  const message = error instanceof Error ? error.message : 'Application failed.';
  console.error(key ? message.replaceAll(key, '[redacted]') : message);
  process.exitCode = 1;
});
