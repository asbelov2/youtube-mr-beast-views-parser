import { resolve } from 'node:path';

export const DEFAULT_TRACKING_WINDOW_DAYS = 14;
export const DEFAULT_POLL_INTERVAL_MINUTES = 5;
export const DEFAULT_FULL_DISCOVERY_INTERVAL_MINUTES = 60;
export const MRBEAST_CHANNEL_ID = 'UCX6OQ3DkcsbYNE6H8uQQuVA';
export const DAY_MS = 24 * 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;

export interface Config {
  apiKey: string;
  channelId: string;
  trackingWindowMs: number;
  pollIntervalMs: number;
  fullDiscoveryIntervalMs: number;
  databasePath: string;
}

function duration(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  unitMs: number,
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  const milliseconds = value * unitMs;
  if (
    !Number.isFinite(value) || value <= 0 ||
    !Number.isSafeInteger(milliseconds) || milliseconds < 1
  ) {
    throw new Error(`${name} must be a positive number with millisecond precision.`);
  }
  return milliseconds;
}

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.DATABASE_PATH?.trim() || './data/mrbeast.sqlite');
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Set YOUTUBE_API_KEY in .env or the environment to collect YouTube statistics.');
  }
  const channelId = env.YOUTUBE_CHANNEL_ID?.trim() || MRBEAST_CHANNEL_ID;
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    throw new Error('YOUTUBE_CHANNEL_ID must be a YouTube channel ID starting with UC.');
  }
  return {
    apiKey,
    channelId,
    trackingWindowMs: duration(env, 'TRACKING_WINDOW_DAYS', DEFAULT_TRACKING_WINDOW_DAYS, DAY_MS),
    pollIntervalMs: duration(env, 'POLL_INTERVAL_MINUTES', DEFAULT_POLL_INTERVAL_MINUTES, MINUTE_MS),
    fullDiscoveryIntervalMs: duration(
      env, 'FULL_DISCOVERY_INTERVAL_MINUTES', DEFAULT_FULL_DISCOVERY_INTERVAL_MINUTES, MINUTE_MS,
    ),
    databasePath: databasePath(env),
  };
}
