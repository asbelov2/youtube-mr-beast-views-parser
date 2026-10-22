import type { Comparison, DayComparison, Forecast } from './analytics.js';
import type { Snapshot, VideoSummary } from './types.js';
import type { FitRange } from './fit-window.js';
import type { HolidayEvent } from './calendar-types.js';

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
  dayComparison: DayComparison;
  forecast: Forecast;
  fitRange: FitRange;
  holidays: HolidayEvent[];
}

export interface OfflineData {
  index: DashboardIndex;
  histories: Record<string, Snapshot[]>;
  calendars: Record<string, HolidayEvent[]>;
  csv: string;
}
