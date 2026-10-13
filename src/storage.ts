import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Video } from './types.js';

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
    `);
  }

  activeVideoIds(channelId: string, now: Date, trackingWindowMs: number): string[] {
    const cutoff = new Date(now.getTime() - trackingWindowMs).toISOString();
    const rows = this.db.prepare(`
      SELECT id FROM videos
      WHERE channel_id = ? AND published_at > ? AND published_at <= ?
      ORDER BY published_at DESC, id
    `).all(channelId, cutoff, now.toISOString());
    return rows.map((row) => String(row.id));
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

  *csv(): Generator<string> {
    yield 'video_id,channel_id,title,published_at,observed_at,view_count\r\n';
    const rows = this.db.prepare(`
      SELECT v.id, v.channel_id, v.title, v.published_at, s.observed_at, s.view_count
      FROM view_snapshots s JOIN videos v ON v.id = s.video_id
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
