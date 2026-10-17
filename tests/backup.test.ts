import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/storage.js';
import { NOW, video } from './helpers.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mrbeast-backup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.sqlite');
  const destination = join(directory, 'backup.sqlite');
  const run = () => spawnSync(process.execPath, [resolve('scripts/backup-database.mjs'), source, destination], { encoding: 'utf8' });
  return { source, destination, run };
}

test('backup includes committed WAL observations without replacing or changing the source', (t) => {
  const { source, destination, run } = fixture(t);
  const store = new Store(source);
  t.after(() => store.close());
  const count = '900719925474099312345';
  store.record([video({ viewCount: count })], NOW.toISOString());
  assert.ok(statSync(`${source}-wal`).size > 0);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { videos: 1, snapshots: 1 });
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  const copy = new DatabaseSync(destination, { readOnly: true });
  t.after(() => copy.close());
  assert.equal(copy.prepare('SELECT view_count FROM view_snapshots').get()!.view_count, count);
  assert.equal(copy.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
  assert.equal(copy.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  store.record([video({ viewCount: '900719925474099312999' })], new Date(NOW.getTime() + 300_000).toISOString());
  assert.equal(store.history(video().id).length, 2);
  assert.equal(copy.prepare('SELECT count(*) AS n FROM view_snapshots').get()!.n, 1);
});

test('backup refuses existing destinations and missing sources without destroying files', (t) => {
  const { source, destination, run } = fixture(t);
  writeFileSync(destination, 'existing backup');
  assert.notEqual(run().status, 0);
  assert.equal(readFileSync(destination, 'utf8'), 'existing backup');
  rmSync(destination);
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(destination), false);
});

test('backup rejects corrupt or incompatible databases before leaving a successful backup', (t) => {
  const { source, destination, run } = fixture(t);
  writeFileSync(source, 'not sqlite');
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(destination), false);
  rmSync(source);
  const empty = new DatabaseSync(source);
  empty.close();
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(destination), false);
});

test('backup rejects broken foreign keys while leaving the original observations intact', (t) => {
  const { source, destination, run } = fixture(t);
  const store = new Store(source);
  store.close();
  const original = new DatabaseSync(source);
  t.after(() => original.close());
  original.exec('PRAGMA foreign_keys = OFF');
  original.prepare('INSERT INTO view_snapshots VALUES (?, ?, ?)').run('missing-video', NOW.toISOString(), '100');
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(destination), false);
  assert.equal(original.prepare('SELECT count(*) AS n FROM view_snapshots').get()!.n, 1);
});
