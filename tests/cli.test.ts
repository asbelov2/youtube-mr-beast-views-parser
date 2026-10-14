import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { MRBEAST_CHANNEL_ID, MRBEAST_GAMING_CHANNEL_ID } from '../src/config.js';
import { Store } from '../src/storage.js';
import { NOW, video } from './helpers.js';

const run = promisify(execFile);
const ENTRY = resolve('src/index.ts');

function environment(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: path };
  delete env.YOUTUBE_API_KEY;
  delete env.YOUTUBE_CHANNEL_ID;
  delete env.YOUTUBE_CHANNEL_IDS;
  delete env.TRACKING_WINDOW_DAYS;
  delete env.POLL_INTERVAL_MINUTES;
  delete env.FULL_DISCOVERY_INTERVAL_MINUTES;
  env.WEB_HOST = '127.0.0.1';
  env.WEB_PORT = '0';
  return env;
}

function mockApi(directory: string, failMain: boolean): string {
  const path = join(directory, 'mock-api.mjs');
  writeFileSync(path, `
    const main = ${JSON.stringify(MRBEAST_CHANNEL_ID)};
    const channelIds = ${JSON.stringify([MRBEAST_CHANNEL_ID, MRBEAST_GAMING_CHANNEL_ID])};
    const publishedAt = new Date(Date.now() - 86400000).toISOString();
    const counts = new Map(channelIds.map(id => [id, 100]));
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      let items;
      if (url.pathname.endsWith('/channels')) {
        const id = url.searchParams.get('id');
        if (${failMain} && id === main) return new Response(JSON.stringify({
          error: { errors: [{ reason: 'quotaExceeded' }] }
        }), { status: 403 });
        items = [{ contentDetails: { relatedPlaylists: { uploads: id } } }];
      } else if (url.pathname.endsWith('/playlistItems')) {
        const id = url.searchParams.get('playlistId');
        items = [{ contentDetails: { videoId: 'video-' + id, videoPublishedAt: publishedAt } }];
      } else if (url.pathname.endsWith('/videos')) {
        const videoId = url.searchParams.get('id');
        const id = channelIds.find(id => 'video-' + id === videoId);
        const count = counts.get(id);
        counts.set(id, count + 1);
        items = [{ id: videoId,
          snippet: { channelId: id, title: 'Test video', publishedAt },
          statistics: { viewCount: String(count) }, status: { privacyStatus: 'public' } }];
      } else { throw new Error('Unexpected API endpoint'); }
      return new Response(JSON.stringify({ items }), { status: 200 });
    };
  `);
  return path;
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

for (const failMain of [false, true]) test(`CLI service collects both channels independently and shuts down cleanly (main fails: ${failMain})`, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mrbeast-cli-service-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'views.sqlite');
  // Test-only transport replaces fetch before the real application starts.
  const mockPath = mockApi(directory, failMain);
  const successfulChannels = failMain ? [MRBEAST_GAMING_CHANNEL_ID] : [MRBEAST_CHANNEL_ID, MRBEAST_GAMING_CHANNEL_ID];
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
    if (!signalled && successfulChannels.every((id) => stdout.split('\n').filter((line) =>
      line.includes('collection_completed') && line.includes(id)).length >= 2)) {
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
    for (const id of successfulChannels) {
      const history = store.history('video-' + id);
      assert.ok(history.length >= 2);
      assert.equal(history[0]!.viewCount, '100');
      assert.equal(history[1]!.viewCount, '101');
    }
    if (failMain) {
      assert.equal(store.history('video-' + MRBEAST_CHANNEL_ID).length, 0);
      assert.match(stderr, /quotaExceeded/);
      assert.match(stderr, new RegExp(MRBEAST_CHANNEL_ID));
    }
  } finally { store.close(); }
});

test('one-off collection saves the working channel and returns failure when the other channel fails', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mrbeast-cli-partial-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'views.sqlite');
  await assert.rejects(run(process.execPath, [
    '--import', 'tsx', '--import', pathToFileURL(mockApi(directory, true)).href, ENTRY, '--once',
  ], { env: { ...environment(path), YOUTUBE_API_KEY: 'test-key' }, timeout: 5_000 }), (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'code' in error && 'stdout' in error && 'stderr' in error);
    assert.equal(error.code, 1);
    assert.match(String(error.stdout), new RegExp(MRBEAST_GAMING_CHANNEL_ID));
    assert.match(String(error.stderr), /quotaExceeded/);
    return true;
  });
  const store = new Store(path);
  try {
    assert.equal(store.history('video-' + MRBEAST_GAMING_CHANNEL_ID).length, 1);
    assert.equal(store.history('video-' + MRBEAST_CHANNEL_ID).length, 0);
  } finally { store.close(); }
});
