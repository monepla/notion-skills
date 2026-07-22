// Thin wrapper around the Notion API with two transports:
//
//   1. NOTION_API_TOKEN env var set  → direct HTTPS calls
//   2. otherwise, `ntn` CLI on PATH  → delegate to `ntn api` (OS-keychain auth)
//
// The third supported mode — Notion MCP connector only — cannot be used from a
// script; in that mode the model itself performs the sync (see skills/sync).

import { execFileSync } from 'node:child_process';

const NOTION_VERSION = process.env.NOTION_VERSION ?? '2025-09-03';
const API_BASE = 'https://api.notion.com/';

/** Fetch every page of a data source (handles pagination). */
export async function queryDataSource(dataSourceId) {
  const results = [];
  let cursor;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const json = await post(`v1/data_sources/${dataSourceId}/query`, body);

    if (!Array.isArray(json.results)) {
      throw new Error(`Unexpected Notion response: ${JSON.stringify(json).slice(0, 400)}`);
    }
    results.push(...json.results);
    cursor = json.has_more ? json.next_cursor : undefined;
  } while (cursor);

  return results;
}

async function post(path, body) {
  const token = process.env.NOTION_API_TOKEN;
  return token ? postHttp(path, body, token) : postViaNtn(path, body);
}

async function postHttp(path, body, token) {
  const res = await fetch(new URL(path, API_BASE), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'notion-version': NOTION_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Notion API ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

function postViaNtn(path, body) {
  let stdout;
  try {
    stdout = execFileSync('ntn', ['api', path, '-X', 'POST', '-d', JSON.stringify(body)], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        'Cannot reach Notion: set NOTION_API_TOKEN, or install the Notion CLI (`ntn`) and run `ntn login`. ' +
          'If you only use the Notion MCP connector, run /notion-skills:sync in a Claude session instead.',
      );
    }
    throw new Error(`ntn api failed: ${err.stderr?.toString().slice(0, 400) ?? err.message}`);
  }
  return JSON.parse(stdout);
}

/** Which script-usable transport is available right now. */
export function detectTransport() {
  if (process.env.NOTION_API_TOKEN) return 'token';
  try {
    execFileSync('ntn', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return 'ntn';
  } catch {
    return null; // MCP-only (or nothing) — scripts cannot sync
  }
}
