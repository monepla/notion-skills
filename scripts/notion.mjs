// Thin wrapper around the Notion API with three transports:
//
//   token → NOTION_API_TOKEN env var set, direct HTTPS calls
//   ntn   → `ntn` CLI on PATH, delegate to `ntn api` (OS-keychain auth)
//   mcp   → the Notion MCP connector. A script cannot call an MCP server, so in
//           this mode the model fetches the rows and hands them to the scripts
//           as JSON (`sync.mjs --from-json` / `setup.mjs --from-json`).
//
// `config.transport` selects one explicitly; 'auto' (the default) prefers token,
// then ntn. Selecting a transport that is unavailable is an error rather than a
// silent fallback — a user who wrote "ntn" wants the keychain path, not a
// surprise switch to whatever token happens to be exported.

import { execFileSync } from 'node:child_process';

const NOTION_VERSION = process.env.NOTION_VERSION ?? '2025-09-03';
const API_BASE = 'https://api.notion.com/';

export const SCRIPT_TRANSPORTS = ['token', 'ntn'];
export const TRANSPORTS = [...SCRIPT_TRANSPORTS, 'mcp'];

/** True if `ntn` is on PATH and runnable. */
export function hasNtn() {
  try {
    execFileSync('ntn', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Which script-usable transport is available right now, ignoring config.
 * Returns 'token' | 'ntn' | null (null = MCP-only, or nothing at all).
 */
export function detectTransport() {
  if (process.env.NOTION_API_TOKEN) return 'token';
  return hasNtn() ? 'ntn' : null;
}

/**
 * Resolve the transport a script should use.
 *
 * Returns { transport, reason }. `transport` is null when no script transport
 * can run, and `reason` then explains why — callers decide whether that is
 * fatal (sync.mjs) or expected (the session-start hook, which must never fail).
 */
export function resolveTransport(configured = 'auto') {
  const want = String(configured || 'auto').toLowerCase();

  if (want === 'mcp') {
    return {
      transport: null,
      reason:
        'config.transport is "mcp": scripts cannot call an MCP server. Run /notion-skills:sync ' +
        'in a Claude session, which queries Notion over MCP and pipes the rows into this script.',
    };
  }

  if (want === 'token') {
    if (process.env.NOTION_API_TOKEN) return { transport: 'token', reason: '' };
    return { transport: null, reason: 'config.transport is "token" but NOTION_API_TOKEN is not set.' };
  }

  if (want === 'ntn') {
    if (hasNtn()) return { transport: 'ntn', reason: '' };
    return {
      transport: null,
      reason:
        'config.transport is "ntn" but the Notion CLI is not on PATH. Install it ' +
        '(https://developers.notion.com/cli/get-started/overview) and run `ntn login`.',
    };
  }

  if (want !== 'auto') {
    return { transport: null, reason: `Unknown transport "${configured}". Use one of: ${TRANSPORTS.join(', ')}.` };
  }

  const detected = detectTransport();
  if (detected) return { transport: detected, reason: '' };
  return {
    transport: null,
    reason:
      'Cannot reach Notion: set NOTION_API_TOKEN, or install the Notion CLI (`ntn`) and run `ntn login`. ' +
      'If you only use the Notion MCP connector, run /notion-skills:sync in a Claude session instead.',
  };
}

/**
 * Resolve the transport or throw with the reason.
 *
 * Always revalidates, even for an already-named transport: `"transport": "ntn"`
 * with no CLI installed should fail saying exactly that, not fall through to a
 * spawn error whose message names a different transport.
 */
function requireTransport(transport) {
  const { transport: resolved, reason } = resolveTransport(transport ?? 'auto');
  if (!resolved) throw new Error(reason);
  return resolved;
}

/** Fetch every page of a data source (handles pagination). */
export async function queryDataSource(dataSourceId, { transport, pageSize = 100 } = {}) {
  const active = requireTransport(transport);
  const results = [];
  let cursor;

  do {
    const body = { page_size: pageSize };
    if (cursor) body.start_cursor = cursor;

    const json = await request('POST', `v1/data_sources/${dataSourceId}/query`, { body, transport: active });

    if (!Array.isArray(json.results)) {
      throw new Error(`Unexpected Notion response: ${JSON.stringify(json).slice(0, 400)}`);
    }
    results.push(...json.results);
    cursor = json.has_more ? json.next_cursor : undefined;
  } while (cursor);

  return results;
}

/** Fetch a database object (used to resolve a database id → data_source_id). */
export async function getDatabase(databaseId, { transport } = {}) {
  return request('GET', `v1/databases/${databaseId}`, { transport: requireTransport(transport) });
}

async function request(method, path, { body, transport } = {}) {
  return transport === 'ntn' ? viaNtn(method, path, body) : viaHttp(method, path, body);
}

async function viaHttp(method, path, body) {
  const token = process.env.NOTION_API_TOKEN;
  if (!token) throw new Error('NOTION_API_TOKEN is not set.');

  const res = await fetch(new URL(path, API_BASE), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'notion-version': NOTION_VERSION,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Notion API ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

function viaNtn(method, path, body) {
  const args = ['api', path];
  if (method !== 'GET') args.push('-X', method);
  if (body) args.push('-d', JSON.stringify(body));

  let stdout;
  try {
    stdout = execFileSync('ntn', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
