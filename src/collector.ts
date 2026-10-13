import type { Config } from './config.js';
import type { Store } from './storage.js';
import { isWithinTrackingWindow, type CollectionResult } from './types.js';
import type { YouTubeClient } from './youtube.js';

export class Collector {
  private lastFullDiscoveryAt: number | undefined;

  constructor(
    private readonly config: Pick<Config, 'channelId' | 'trackingWindowMs' | 'fullDiscoveryIntervalMs'>,
    private readonly youtube: Pick<YouTubeClient, 'recentVideoIds' | 'videos'>,
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async collect(signal?: AbortSignal): Promise<CollectionResult> {
    const startedAt = this.now();
    const cutoff = new Date(startedAt.getTime() - this.config.trackingWindowMs);
    const fullScan = this.lastFullDiscoveryAt === undefined ||
      startedAt.getTime() - this.lastFullDiscoveryAt >= this.config.fullDiscoveryIntervalMs;
    const discoveredIds = await this.youtube.recentVideoIds(cutoff, signal, fullScan);
    const activeIds = this.store.activeVideoIds(
      this.config.channelId, startedAt, this.config.trackingWindowMs,
    );
    const ids = [...new Set([...discoveredIds, ...activeIds])];
    const videos = await this.youtube.videos(ids, signal);
    signal?.throwIfAborted();
    const observedAt = this.now();
    const eligible = videos.filter((video) =>
      video.channelId === this.config.channelId &&
      isWithinTrackingWindow(video.publishedAt, observedAt, this.config.trackingWindowMs),
    );
    // No permanent "finished" flag: increasing the window reactivates eligible videos.
    // All requests must succeed before saving a cycle, so failed runs leave no partial data.
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
