import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_MS, MRBEAST_CHANNEL_ID } from '../src/config.js';
import { YouTubeApiError, YouTubeClient } from '../src/youtube.js';
import { apiVideo, json, NOW, video } from './helpers.js';

function client(fetch: typeof globalThis.fetch): YouTubeClient {
  return new YouTubeClient({ apiKey: 'test-secret', channelId: MRBEAST_CHANNEL_ID, fetch, retryDelayMs: 1 });
}

test('discovers recent videos across out-of-order pages, deduplicates and caches playlist ID', async () => {
  let channelRequests = 0;
  const cutoff = new Date(NOW.getTime() - 14 * DAY_MS);
  const youtube = client(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.has('key'), false);
    assert.equal(new Headers(init?.headers).get('X-Goog-Api-Key'), 'test-secret');
    if (url.pathname.endsWith('/channels')) {
      channelRequests++;
      return json({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'uploads-id' } } }] });
    }
    assert.equal(url.searchParams.get('playlistId'), 'uploads-id');
    if (!url.searchParams.has('pageToken')) {
      return json({ items: [
        { contentDetails: { videoId: 'old', videoPublishedAt: new Date(cutoff.getTime() - 1).toISOString() } },
        { contentDetails: { videoId: 'boundary', videoPublishedAt: cutoff.toISOString() } },
      ], nextPageToken: 'second' });
    }
    assert.equal(url.searchParams.get('pageToken'), 'second');
    return json({ items: [
      { contentDetails: { videoId: 'fresh', videoPublishedAt: NOW.toISOString() } },
      { contentDetails: { videoId: 'fresh', videoPublishedAt: NOW.toISOString() } },
      { contentDetails: { videoId: 'unknown-date' } },
    ] });
  });
  assert.deepEqual(await youtube.recentVideoIds(cutoff), ['fresh', 'unknown-date']);
  assert.deepEqual(await youtube.recentVideoIds(cutoff), ['fresh', 'unknown-date']);
  assert.equal(channelRequests, 1);
});

test('a lightweight discovery reads only the first upload page', async () => {
  let playlistRequests = 0;
  const youtube = client(async (input) => {
    if (String(input).includes('/channels?')) return json({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'u' } } }] });
    playlistRequests++;
    return json({ items: [{ contentDetails: { videoId: 'fresh', videoPublishedAt: NOW.toISOString() } }], nextPageToken: 'next' });
  });
  assert.deepEqual(await youtube.recentVideoIds(new Date(NOW.getTime() - DAY_MS), undefined, false), ['fresh']);
  assert.equal(playlistRequests, 1);
});

test('detects repeated pagination tokens instead of looping forever', async () => {
  const youtube = client(async (input) => String(input).includes('/channels?')
    ? json({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'u' } } }] })
    : json({ items: [], nextPageToken: 'same' }));
  await assert.rejects(youtube.recentVideoIds(NOW), /repeated playlist page token/);
});

test('requests video IDs in batches of 50 and preserves integer precision', async () => {
  const batches: string[][] = [];
  const youtube = client(async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('part'), 'snippet,statistics,status');
    const ids = url.searchParams.get('id')!.split(',');
    batches.push(ids);
    return json({ items: ids.map((id) => apiVideo({ id, statistics: { viewCount: '9007199254740993123' } })) });
  });
  const ids = Array.from({ length: 101 }, (_, i) => `video-${i}`);
  const result = await youtube.videos([...ids, ids[0]!]);
  assert.deepEqual(batches.map((b) => b.length), [50, 50, 1]);
  assert.equal(result.length, 101);
  assert.equal(result[0]!.viewCount, '9007199254740993123');
});

test('no statistics call is made for an empty set', async () => {
  const youtube = client(async () => { throw new Error('should not fetch'); });
  assert.deepEqual(await youtube.videos([]), []);
});

test('skips private videos, upcoming premieres, other channels and unavailable view counts', async () => {
  const v = video();
  const youtube = client(async () => json({ items: [
    apiVideo(),
    apiVideo({ id: 'private', status: { privacyStatus: 'private' } }),
    apiVideo({ id: 'premiere', snippet: { channelId: v.channelId, liveBroadcastContent: 'upcoming' } }),
    apiVideo({ id: 'other', snippet: { channelId: 'another-channel' } }),
    apiVideo({ id: 'no-count', statistics: {} }),
  ] }));
  assert.deepEqual(await youtube.videos([v.id, 'private', 'premiere', 'other', 'no-count', 'deleted']), [v]);
});

test('rejects malformed counts, dates and unrelated returned IDs', async () => {
  for (const item of [
    apiVideo({ statistics: { viewCount: '1.5' } }),
    apiVideo({ snippet: { ...apiVideo().snippet as object, publishedAt: 'not-a-date' } }),
    apiVideo({ id: 'unexpected' }),
  ]) {
    await assert.rejects(client(async () => json({ items: [item] })).videos(['fresh-video']), /Invalid YouTube response/);
  }
});

test('retries transient HTTP failures and eventually succeeds', async () => {
  let calls = 0;
  const youtube = client(async () => {
    calls++;
    return calls < 3 ? json({ error: { errors: [{ reason: 'backendError' }] } }, calls === 1 ? 503 : 429)
      : json({ items: [apiVideo()] });
  });
  assert.equal((await youtube.videos(['fresh-video'])).length, 1);
  assert.equal(calls, 3);
});

test('retries transport failures with a bounded number of attempts', async () => {
  let calls = 0;
  const youtube = client(async () => { calls++; throw new TypeError('network unavailable with test-secret'); });
  await assert.rejects(youtube.videos(['fresh-video']), /network request failed/);
  assert.equal(calls, 3);
});

test('quota failures are actionable, do not retry and never include upstream key values', async () => {
  let calls = 0;
  const youtube = client(async () => {
    calls++;
    return json({ error: { message: 'invalid key test-secret', errors: [{ reason: 'quotaExceeded' }] } }, 403);
  });
  await assert.rejects(youtube.videos(['fresh-video']), (error: unknown) => {
    assert.ok(error instanceof YouTubeApiError);
    assert.equal(error.status, 403);
    assert.match(error.message, /quotaExceeded/);
    assert.doesNotMatch(error.message, /test-secret/);
    return true;
  });
  assert.equal(calls, 1);
});

test('an aborted operation makes no network request', async () => {
  const abort = new AbortController();
  abort.abort();
  const youtube = client(async () => { throw new Error('should not fetch'); });
  await assert.rejects(youtube.videos(['fresh-video'], abort.signal), { name: 'AbortError' });
});
