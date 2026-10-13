import type { Comparison, Forecast } from './analytics.js';
import type { Snapshot, VideoSummary } from './types.js';

export interface DashboardIndex {
  videos: Array<VideoSummary & { tracking: boolean }>;
  generatedAt: string;
  trackingWindowDays: number;
  retentionDays: number;
  pollIntervalMinutes: number;
}

export interface DashboardVideo {
  video: VideoSummary;
  history: Snapshot[];
  comparison: Comparison;
  forecast: Forecast;
}

export interface OfflineData {
  index: DashboardIndex;
  histories: Record<string, Snapshot[]>;
  csv: string;
}
