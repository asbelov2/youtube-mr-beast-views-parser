export interface Video {
  id: string;
  channelId: string;
  title: string;
  publishedAt: string;
  // Keep exact integer counts, including values above Number.MAX_SAFE_INTEGER.
  viewCount: string;
}

export interface CollectionResult {
  observedAt: string;
  candidates: number;
  recorded: number;
  skipped: number;
}

export interface Snapshot {
  observedAt: string;
  viewCount: string;
}

export interface VideoSummary {
  id: string;
  channelId: string;
  title: string;
  publishedAt: string;
  firstObservedAt: string;
  lastObservedAt: string;
  viewCount: string;
  observations: number;
}

export function isWithinTrackingWindow(
  publishedAt: string,
  now: Date,
  trackingWindowMs: number,
): boolean {
  const age = now.getTime() - Date.parse(publishedAt);
  return age >= 0 && age < trackingWindowMs;
}
