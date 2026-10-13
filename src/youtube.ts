import { setTimeout as sleep } from 'node:timers/promises';
import type { Video } from './types.js';

const API_ROOT = 'https://www.googleapis.com/youtube/v3/';
const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

type JsonObject = Record<string, unknown>;

function object(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid YouTube response: ${context}.`);
  }
  return value as JsonObject;
}

function items(value: unknown): JsonObject[] {
  const data = object(value, 'expected an object');
  if (!Array.isArray(data.items)) {
    throw new Error('Invalid YouTube response: missing items.');
  }
  return data.items.map((item) => object(item, 'expected an item'));
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid YouTube response: missing ${context}.`);
  }
  return value;
}

export class YouTubeApiError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`YouTube API returned HTTP ${status} (${reason}).`);
    this.name = 'YouTubeApiError';
  }
}

interface ClientOptions {
  apiKey: string;
  channelId: string;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}

export class YouTubeClient {
  private readonly fetch: typeof fetch;
  private readonly retryDelayMs: number;
  private uploadsPlaylistId: string | undefined;

  constructor(private readonly options: ClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  private async request(
    endpoint: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(endpoint, API_ROOT);
    url.search = new URLSearchParams(params).toString();

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      let failure: Error;
      try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const response = await this.fetch(url, {
          headers: { 'X-Goog-Api-Key': this.options.apiKey },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (response.ok) return await response.json() as unknown;

        // Do not log upstream messages or request headers: they may contain a key.
        let reason = 'requestFailed';
        try {
          const body = object(await response.json() as unknown, 'error body');
          const error = object(body.error, 'error');
          if (Array.isArray(error.errors)) {
            const first = object(error.errors[0], 'error reason');
            if (typeof first.reason === 'string' && /^[A-Za-z0-9_-]+$/.test(first.reason)) {
              reason = first.reason;
            }
          }
        } catch {
          // HTTP status remains sufficient when the error body is unavailable.
        }
        failure = new YouTubeApiError(response.status, reason);
        if (response.status !== 429 && response.status < 500) throw failure;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof YouTubeApiError) throw error;
        // Only retry transport failures/timeouts; malformed data is a hard failure.
        if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'TimeoutError')) {
          throw error;
        }
        failure = new Error('YouTube API network request failed or timed out.');
      }

      if (attempt === MAX_ATTEMPTS - 1) throw failure;
      await sleep(this.retryDelayMs * 2 ** attempt, undefined, signal ? { signal } : {});
    }
    throw new Error('YouTube request attempts exhausted.');
  }

  private async uploadsPlaylist(signal?: AbortSignal): Promise<string> {
    if (this.uploadsPlaylistId) return this.uploadsPlaylistId;
    const response = await this.request('channels', {
      part: 'contentDetails', id: this.options.channelId,
    }, signal);
    const channel = items(response)[0];
    if (!channel) throw new Error('YouTube channel was not found or is unavailable.');
    const details = object(channel.contentDetails, 'channel contentDetails');
    const playlists = object(details.relatedPlaylists, 'relatedPlaylists');
    this.uploadsPlaylistId = text(playlists.uploads, 'uploads playlist');
    return this.uploadsPlaylistId;
  }

  async recentVideoIds(cutoff: Date, signal?: AbortSignal, fullScan = true): Promise<string[]> {
    const playlistId = await this.uploadsPlaylist(signal);
    const ids = new Set<string>();
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;

    do {
      const params: Record<string, string> = {
        part: 'contentDetails', playlistId, maxResults: String(PAGE_SIZE),
      };
      if (pageToken) params.pageToken = pageToken;
      const response = await this.request('playlistItems', params, signal);
      for (const item of items(response)) {
        const details = object(item.contentDetails, 'playlist contentDetails');
        const id = text(details.videoId, 'videoId');
        const publishedAt = typeof details.videoPublishedAt === 'string'
          ? Date.parse(details.videoPublishedAt) : NaN;
        // Missing dates are resolved via videos.list; the canonical date is checked again.
        if (!Number.isFinite(publishedAt) || publishedAt > cutoff.getTime()) ids.add(id);
      }
      const data = object(response, 'playlist response');
      pageToken = data.nextPageToken === undefined
        ? undefined : text(data.nextPageToken, 'nextPageToken');
      if (pageToken && seenTokens.has(pageToken)) {
        throw new Error('Invalid YouTube response: repeated playlist page token.');
      }
      if (pageToken) seenTokens.add(pageToken);
      if (!fullScan) break;
      // Scan all pages: upload ordering need not match public publication dates.
    } while (pageToken);

    return [...ids];
  }

  async videos(ids: string[], signal?: AbortSignal): Promise<Video[]> {
    const result: Video[] = [];
    const uniqueIds = [...new Set(ids)];
    for (let offset = 0; offset < uniqueIds.length; offset += PAGE_SIZE) {
      const batch = uniqueIds.slice(offset, offset + PAGE_SIZE);
      const response = await this.request('videos', {
        part: 'snippet,statistics,status', id: batch.join(','), maxResults: String(PAGE_SIZE),
      }, signal);
      for (const item of items(response)) {
        const id = text(item.id, 'video id');
        if (!batch.includes(id)) throw new Error('Invalid YouTube response: unexpected video id.');
        const snippet = object(item.snippet, 'video snippet');
        const status = object(item.status, 'video status');
        if (status.privacyStatus !== 'public' || snippet.liveBroadcastContent === 'upcoming') continue;
        if (snippet.channelId !== this.options.channelId) continue;
        const statistics = object(item.statistics, 'video statistics');
        if (statistics.viewCount === undefined) continue;
        const count = text(statistics.viewCount, 'viewCount');
        if (!/^\d+$/.test(count)) throw new Error('Invalid YouTube response: invalid viewCount.');
        const publishedAt = text(snippet.publishedAt, 'publishedAt');
        if (!Number.isFinite(Date.parse(publishedAt))) {
          throw new Error('Invalid YouTube response: invalid publishedAt.');
        }
        result.push({
          id,
          channelId: this.options.channelId,
          title: text(snippet.title, 'title'),
          publishedAt: new Date(publishedAt).toISOString(),
          viewCount: BigInt(count).toString(),
        });
      }
    }
    return result;
  }
}
