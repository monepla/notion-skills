// The probe must cost exactly one request.
//
// resolveDataSourceId used queryDataSource with pageSize 1 to ask "is this id a
// data source?". queryDataSource follows every pagination cursor, so the probe
// walked the whole store one row at a time — 66 requests against a 66-row
// database, and a rate limit against a large one. On the path whose entire
// purpose is making setup fast.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NOTION_SKILLS_HOME = mkdtempSync(join(tmpdir(), 'notion-skills-probe-'));
process.env.NOTION_API_TOKEN = 'test-token';

const { probeDataSource, queryDataSource } = await import('../scripts/notion.mjs');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch with a source of `total` rows, one row per response. */
function stubPagedSource(total) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const start = body.start_cursor ? Number(body.start_cursor) : 0;
    const size = body.page_size ?? 100;
    const end = Math.min(start + size, total);
    return new Response(
      JSON.stringify({
        results: Array.from({ length: end - start }, (_, i) => ({ id: `id-${start + i}`, properties: {} })),
        has_more: end < total,
        next_cursor: end < total ? String(end) : null,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return calls;
}

describe('probeDataSource', () => {
  test('makes exactly one request regardless of how many rows exist', async () => {
    for (const total of [1, 66, 5000]) {
      const calls = stubPagedSource(total);
      await probeDataSource('ds-1', { transport: 'token' });
      assert.equal(calls.length, 1, `${total} rows should still cost 1 request`);
      assert.equal(calls[0].body.page_size, 1);
      assert.equal(calls[0].body.start_cursor, undefined, 'a probe never continues a cursor');
    }
  });

  test('returns the raw response, has_more included', async () => {
    stubPagedSource(66);
    const json = await probeDataSource('ds-1', { transport: 'token' });
    assert.equal(json.has_more, true);
    assert.equal(json.results.length, 1);
  });

  test('propagates an API error so the caller can tell 404 from 401', async () => {
    globalThis.fetch = async () => new Response('{"code":"unauthorized"}', { status: 401 });
    await assert.rejects(() => probeDataSource('ds-1', { transport: 'token' }), /Notion API 401/);
  });
});

describe('queryDataSource still fetches everything', () => {
  test('follows every cursor — this is the behaviour a probe must not use', async () => {
    const calls = stubPagedSource(5);
    const rows = await queryDataSource('ds-1', { transport: 'token', pageSize: 1 });
    assert.equal(rows.length, 5);
    assert.equal(calls.length, 5);
  });

  test('one request when the page holds everything', async () => {
    const calls = stubPagedSource(60);
    const rows = await queryDataSource('ds-1', { transport: 'token' });
    assert.equal(rows.length, 60);
    assert.equal(calls.length, 1);
  });
});
