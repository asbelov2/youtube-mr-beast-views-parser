import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Store } from '../src/storage.js';
import { NOW, video } from './helpers.js';

const run = promisify(execFile);
const ENTRY = resolve('src/index.ts');

function environment(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: path };
  delete env.YOUTUBE_API_KEY;
  delete env.YOUTUBE_CHANNEL_ID;
  delete env.TRACKING_WINDOW_DAYS;
  delete env.POLL_INTERVAL_MINUTES;
  delete env.FULL_DISCOVERY_INTERVAL_MINUTES;
  env.WEB_HOST = '127.0.0.1';
  env.WEB_PORT = '0';
  return env;
}

test('CLI help works without a key or database', async () => {
  const { stdout } = await run(process.execPath, ['--import', 'tsx', ENTRY, '--help'], {
    env: environment('/unused/mrbeast.sqlite'), timeout: 5_000,
  });
  assert.match(stdout, /default 5 minutes/);
  assert.match(stdout, /TRACKING_WINDOW_DAYS/);
});

test('CLI one-off collection fails clearly without a key and creates no database', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mrbeast-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'views.sqlite');
  await assert.rejects(run(process.execPath, ['--import', 'tsx', ENTRY, '--once'], {
    env: environment(path), timeout: 5_000,
  }), (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'code' in error && 'stderr' in error);
    assert.equal(error.code, 1);
    assert.match(String(error.stderr), /Set YOUTUBE_API_KEY/);
    return true;
  });
  assert.equal(existsSync(path), false);
});

test('CLI exports the actual saved CSV without a key or diagnostic noise in stdout', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mrbeast-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'views.sqlite');
  const store = new Store(path);
  store.record([video()], NOW.toISOString());
  const expected = [...store.csv()].join('');
  store.close();
  const { stdout } = await run(process.execPath, ['--import', 'tsx', ENTRY, '--export-csv'], {
    env: environment(path), timeout: 5_000,
  });
  assert.equal(stdout, expected);
});

test('CLI service collects repeatedly and shuts down cleanly on SIGTERM', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mrbeast-cli-service-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'views.sqlite');
  const mockPath = join(directory, 'mock-api.mjs');
  // Test-only transport replaces fetch before the real application starts.
  writeFileSync(mockPath, `
    const publishedAt = new Date(Date.now() - 86400000).toISOString();
    let count = 100;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      let items;
      if (url.pathname.endsWith('/channels')) {
        items = [{ contentDetails: { relatedPlaylists: { uploads: 'uploads' } } }];
      } else if (url.pathname.endsWith('/playlistItems')) {
        items = [{ contentDetails: { videoId: 'fresh-video', videoPublishedAt: publishedAt } }];
      } else if (url.pathname.endsWith('/videos')) {
        items = [{ id: 'fresh-video',
          snippet: { channelId: 'UCX6OQ3DkcsbYNE6H8uQQuVA', title: 'Test video', publishedAt },
          statistics: { viewCount: String(count++) }, status: { privacyStatus: 'public' } }];
      } else { throw new Error('Unexpected API endpoint'); }
      return new Response(JSON.stringify({ items }), { status: 200 });
    };
  `);
  const child = spawn(process.execPath, [
    '--use-env-proxy', '--import', 'tsx', '--import', pathToFileURL(mockPath).href, ENTRY,
  ], {
    env: { ...environment(path), YOUTUBE_API_KEY: 'test-key', POLL_INTERVAL_MINUTES: '0.0005' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  let signalled = false;
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
    if (!signalled && stdout.split('\n').filter((line) => line.includes('collection_completed')).length >= 2) {
      signalled = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI service timed out')); }, 5_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, stderr);
        assert.equal(signal, null);
        resolvePromise();
      } catch (error) { reject(error); }
    });
  });
  assert.equal(signalled, true);
  const store = new Store(path);
  try {
    assert.ok([...store.csv()].length >= 3);
  } finally { store.close(); }
});
