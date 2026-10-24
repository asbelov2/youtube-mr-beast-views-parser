import { RETENTION_WINDOW_MULTIPLIER, type Config } from './config.js';
import type { Store } from './storage.js';
import { isWithinTrackingWindow, type CollectionResult } from './types.js';
import type { YouTubeClient } from './youtube.js';

export class Collector {
  private lastFullDiscoveryAt: number | undefined;

  constructor(
    private readonly config: Pick<Config, 'trackingWindowMs' | 'fullDiscoveryIntervalMs'> & { channelId: string },
    private readonly youtube: Pick<YouTubeClient, 'recentVideoIds' | 'shortVideoIds' | 'videos'>,
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async collect(signal?: AbortSignal): Promise<CollectionResult> {
    const startedAt = this.now();
    this.store.pruneExpired(
      this.config.channelId, startedAt, this.config.trackingWindowMs * RETENTION_WINDOW_MULTIPLIER,
    );
    const cutoff = new Date(startedAt.getTime() - this.config.trackingWindowMs);
    const fullScan = this.lastFullDiscoveryAt === undefined ||
      startedAt.getTime() - this.lastFullDiscoveryAt >= this.config.fullDiscoveryIntervalMs;
    const shortIds = await this.youtube.shortVideoIds(signal, fullScan);
    const shorts = new Set([...shortIds, ...this.store.excludedShortIds(this.config.channelId)]);
    const discoveredIds = await this.youtube.recentVideoIds(cutoff, signal, fullScan);
    const activeIds = this.store.activeVideoIds(
      this.config.channelId, startedAt, this.config.trackingWindowMs,
    );
    const ids = [...new Set([...discoveredIds, ...activeIds])];
    const videos = await this.youtube.videos(ids.filter((id) => !shorts.has(id)), signal);
    signal?.throwIfAborted();
    const observedAt = this.now();
    const eligible = videos.filter((video) =>
      video.channelId === this.config.channelId &&
      !shorts.has(video.id) &&
      isWithinTrackingWindow(video.publishedAt, observedAt, this.config.trackingWindowMs),
    );
    // No permanent "finished" flag: increasing the window reactivates eligible videos.
    // All requests must succeed before saving a cycle, so failed runs leave no partial data.
    this.store.excludeShorts(this.config.channelId, shortIds);
    this.store.record(eligible, observedAt.toISOString());
    if (fullScan) this.lastFullDiscoveryAt = startedAt.getTime();
    return {
      observedAt: observedAt.toISOString(),
      candidates: ids.length,
      recorded: eligible.length,
      skipped: ids.length - eligible.length,
    };
  }
}
