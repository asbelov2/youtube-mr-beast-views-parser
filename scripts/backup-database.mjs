// A consistent SQLite snapshot, including committed WAL pages. Never copy the
// live .sqlite file alone: recent observations may still be in its WAL.
import { closeSync, openSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const [source, destination] = process.argv.slice(2);
if (!source || !destination || resolve(source) === resolve(destination)) {
  throw new Error('Usage: node scripts/backup-database.mjs SOURCE.sqlite NEW-BACKUP.sqlite');
}
// Reserve a new, private file; an existing backup or live database is never overwritten.
closeSync(openSync(destination, 'wx', 0o600));
let original;
let copy;
try {
  original = new DatabaseSync(source, { readOnly: true });
  await backup(original, destination);
  copy = new DatabaseSync(destination);
  copy.exec('PRAGMA journal_mode = DELETE');
  const integrity = copy.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || copy.prepare('PRAGMA foreign_key_check').all().length) {
    throw new Error('Backup failed integrity or foreign-key validation');
  }
  const videos = copy.prepare('SELECT count(*) AS count FROM videos').get().count;
  const snapshots = copy.prepare('SELECT count(*) AS count FROM view_snapshots').get().count;
  console.log(JSON.stringify({ videos, snapshots }));
} catch (error) {
  copy?.close();
  copy = undefined;
  rmSync(destination, { force: true });
  rmSync(`${destination}-wal`, { force: true });
  rmSync(`${destination}-shm`, { force: true });
  throw error;
} finally {
  copy?.close();
  original?.close();
}
