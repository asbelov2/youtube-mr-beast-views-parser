import { DAY_MS, MRBEAST_CHANNEL_ID } from '../src/config.js';
import type { Video } from '../src/types.js';

export const NOW = new Date('2026-10-13T12:00:00.000Z');
export const CONFIG = {
  channelId: MRBEAST_CHANNEL_ID,
  trackingWindowMs: 14 * DAY_MS,
  fullDiscoveryIntervalMs: 60 * 60_000,
};

export function video(overrides: Partial<Video> = {}): Video {
  return {
    id: 'fresh-video',
    channelId: MRBEAST_CHANNEL_ID,
    title: 'A MrBeast video',
    publishedAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
    viewCount: '1000000',
    ...overrides,
  };
}

export function apiVideo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const v = video();
  return {
    id: v.id,
    snippet: {
      title: v.title, channelId: v.channelId, publishedAt: v.publishedAt,
      liveBroadcastContent: 'none',
    },
    statistics: { viewCount: v.viewCount },
    status: { privacyStatus: 'public' },
    ...overrides,
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}
