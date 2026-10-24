import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Snapshot, Video, VideoSummary } from './types.js';

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        published_at TEXT NOT NULL,
        discovered_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS videos_by_channel_date ON videos(channel_id, published_at);
      CREATE TABLE IF NOT EXISTS view_snapshots (
        video_id TEXT NOT NULL REFERENCES videos(id),
        observed_at TEXT NOT NULL,
        view_count TEXT NOT NULL,
        PRIMARY KEY(video_id, observed_at)
      );
      CREATE INDEX IF NOT EXISTS snapshots_by_date ON view_snapshots(observed_at);
      CREATE TABLE IF NOT EXISTS excluded_shorts (
        video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE
      );
    `);
  }

  activeVideoIds(channelId: string, now: Date, trackingWindowMs: number): string[] {
    const cutoff = new Date(now.getTime() - trackingWindowMs).toISOString();
    const rows = this.db.prepare(`
      SELECT id FROM videos
      WHERE channel_id = ? AND published_at > ? AND published_at <= ?
        AND NOT EXISTS (SELECT 1 FROM excluded_shorts e WHERE e.video_id = videos.id)
      ORDER BY published_at DESC, id
    `).all(channelId, cutoff, now.toISOString());
    return rows.map((row) => String(row.id));
  }

  excludedShortIds(channelId: string): string[] {
    return this.db.prepare(`SELECT e.video_id FROM excluded_shorts e JOIN videos v ON v.id = e.video_id
      WHERE v.channel_id = ?`).all(channelId).map((row) => String(row.video_id));
  }

  /** Hide previously collected Shorts without removing their observations.
   * Only IDs already stored for this channel can be classified here.
   */
  excludeShorts(channelId: string, ids: readonly string[]): void {
    if (!ids.length) return;
    const exclude = this.db.prepare(`
      INSERT INTO excluded_shorts (video_id)
      SELECT id FROM videos WHERE id = ? AND channel_id = ?
      ON CONFLICT(video_id) DO NOTHING
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of new Set(ids)) exclude.run(id, channelId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  record(videos: Video[], observedAt: string): void {
    const upsertVideo = this.db.prepare(`
      INSERT INTO videos (id, channel_id, title, published_at, discovered_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel_id = excluded.channel_id,
        title = excluded.title,
        published_at = excluded.published_at
    `);
    const insertSnapshot = this.db.prepare(`
      INSERT INTO view_snapshots (video_id, observed_at, view_count)
      VALUES (?, ?, ?)
      ON CONFLICT(video_id, observed_at) DO NOTHING
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const video of videos) {
        upsertVideo.run(video.id, video.channelId, video.title, video.publishedAt, observedAt);
        insertSnapshot.run(video.id, observedAt, video.viewCount);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pruneExpired(channelId: string, now: Date, retentionMs: number): number {
    const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Explicit deletes also work with databases created before retention was added.
      this.db.prepare(`
        DELETE FROM view_snapshots WHERE video_id IN (
          SELECT id FROM videos WHERE channel_id = ? AND published_at < ?
        )
      `).run(channelId, cutoff);
      const result = this.db.prepare('DELETE FROM videos WHERE channel_id = ? AND published_at < ?')
        .run(channelId, cutoff);
      this.db.exec('COMMIT');
      return Number(result.changes);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listVideos(channelIds: string | readonly string[]): VideoSummary[] {
    const ids = typeof channelIds === 'string' ? [channelIds] : channelIds;
    if (ids.length === 0) return [];
    return this.db.prepare(`
      SELECT v.*, a.first_observed_at, a.last_observed_at, a.observations, s.view_count
      FROM videos v JOIN (
        SELECT video_id, min(observed_at) AS first_observed_at,
          max(observed_at) AS last_observed_at, count(*) AS observations
        FROM view_snapshots GROUP BY video_id
      ) a ON a.video_id = v.id
      JOIN view_snapshots s ON s.video_id = v.id AND s.observed_at = a.last_observed_at
      WHERE v.channel_id IN (${ids.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM excluded_shorts e WHERE e.video_id = v.id)
      ORDER BY v.published_at DESC, v.id
    `).all(...ids).map((row) => ({
      id: String(row.id), channelId: String(row.channel_id), title: String(row.title),
      publishedAt: String(row.published_at), firstObservedAt: String(row.first_observed_at),
      lastObservedAt: String(row.last_observed_at), viewCount: String(row.view_count),
      observations: Number(row.observations),
    }));
  }

  history(videoId: string): Snapshot[] {
    return this.db.prepare(`
      SELECT observed_at, view_count FROM view_snapshots WHERE video_id = ? ORDER BY observed_at
    `).all(videoId).map((row) => ({ observedAt: String(row.observed_at), viewCount: String(row.view_count) }));
  }

  *csv(): Generator<string> {
    yield 'video_id,channel_id,title,published_at,observed_at,view_count\r\n';
    const rows = this.db.prepare(`
      SELECT v.id, v.channel_id, v.title, v.published_at, s.observed_at, s.view_count
      FROM view_snapshots s JOIN videos v ON v.id = s.video_id
      WHERE NOT EXISTS (SELECT 1 FROM excluded_shorts e WHERE e.video_id = v.id)
      ORDER BY s.observed_at, v.id
    `).iterate();
    for (const row of rows) {
      yield [row.id, row.channel_id, row.title, row.published_at, row.observed_at, row.view_count]
        .map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',') + '\r\n';
    }
  }

  close(): void {
    this.db.close();
  }
}
