#!/usr/bin/env node
// Sync the user's Notion Skills DB into the local registry cache.
//
//   node scripts/sync.mjs                     fetch over token/ntn and write the registry
//   node scripts/sync.mjs --quiet             same, but only errors go to stderr
//   node scripts/sync.mjs --from-json rows.json   use rows already fetched over MCP
//   node scripts/sync.mjs --from-json -       ...read those rows from stdin
//
// --from-json is the MCP path: a script cannot call an MCP server, so the model
// runs one `notion-query-data-sources` query and hands the result here. Every
// transport then shares this one filter/render/write implementation, instead of
// the model transcribing the registry by hand.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { queryDataSource } from './notion.mjs';
import {
  REGISTRY_PATH,
  STATE_DIR,
  dashless,
  excludedPageIds,
  loadConfig,
  normalizeRow,
  renderRegistry,
  rowsFromPayload,
} from './lib.mjs';

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const lastComma = Math.max(head.lastIndexOf(','), head.lastIndexOf('、'));
  return `${(lastComma > 0 ? head.slice(0, lastComma) : head).trim()} …`;
}

/** Normalize, filter and sort raw rows (REST pages or MCP rows) into registry rows. */
export function buildRows(rawRows, config, log = () => {}) {
  const excluded = config.excluded_status.map((status) => status.toLowerCase());
  const excludedIds = excludedPageIds(config);
  const seenExcluded = new Set();
  const rows = [];
  let missingId = 0;

  for (const raw of rawRows) {
    const row = normalizeRow(raw, config.properties);
    if (!row) {
      missingId += 1;
      continue;
    }

    const key = dashless(row.id.toLowerCase());
    if (excludedIds.has(key)) {
      seenExcluded.add(key);
      continue;
    }

    if (!row.name) {
      log(`warn: skipping page with empty ${config.properties.name}: ${row.id}`);
      continue;
    }

    if (row.status && excluded.includes(row.status.toLowerCase())) continue;

    if (!row.trigger) {
      log(`warn: ${row.name} has no ${config.properties.trigger} — routing will rely on its name only`);
    }

    rows.push({
      id: row.id,
      name: row.name,
      // Missing Runtime property (or empty) means the skill is portable.
      runtime: row.runtime.toLowerCase() || 'any',
      category: row.category,
      trigger: truncate(row.trigger, config.max_trigger_chars),
    });
  }

  // Rows without an id can never be fetched again, so a registry built from them
  // would route to nothing. The usual cause is an MCP query whose SELECT omits
  // `id`; say so rather than writing a registry that is quietly short.
  if (missingId) {
    throw new Error(
      `${missingId} row(s) carry no page id. If these came from the Notion MCP connector, ` +
        'include `id` in the SELECT: SELECT id, "Name", "Trigger", "Status", "Category", "Runtime" FROM …',
    );
  }

  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.name)) log(`warn: duplicate skill name "${row.name}" — consider archiving one`);
    else seen.set(row.name, row.id);
  }

  // A stale entry here silently keeps nothing out, so surface it rather than ignore it.
  for (const id of excludedIds) {
    if (!seenExcluded.has(id)) log(`warn: excluded_pages entry not found in the database: ${id}`);
  }
  if (seenExcluded.size) log(`excluded ${seenExcluded.size} page(s) via excluded_pages`);

  rows.sort((a, b) => a.category.localeCompare(b.category, 'en') || a.name.localeCompare(b.name, 'en'));
  return rows;
}

/** Render and write the registry. Returns { count, changed, path }. */
export function writeRegistry(rows, config, now = new Date()) {
  const output = renderRegistry(rows, config.data_source_id, now.toISOString());
  const current = safeRead(REGISTRY_PATH);

  // Always rewrite (the synced timestamp must advance), but report whether the
  // skill list itself changed. Header lines (comments) are excluded from the diff.
  const body = (text) => text.split('\n').filter((line) => !line.startsWith('<!--')).join('\n');

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, output);
  return { count: rows.length, changed: body(current) !== body(output), path: REGISTRY_PATH };
}

/** Fetch rows for a config, either from a supplied JSON payload or over the wire. */
export async function collectRows(config, fromJson) {
  if (fromJson) return rowsFromPayload(JSON.parse(readSource(fromJson)));
  return queryDataSource(config.data_source_id, { transport: config.transport });
}

/** Full sync: collect → build → write. Returns the writeRegistry result. */
export async function runSync(config, { fromJson, log = () => {} } = {}) {
  const rows = buildRows(await collectRows(config, fromJson), config, log);
  if (rows.length === 0) {
    throw new Error('Registry came out empty — check the database ID and property names in config.json.');
  }
  return writeRegistry(rows, config);
}

function readSource(path) {
  return readFileSync(path === '-' ? 0 : path, 'utf8');
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const options = { quiet: false, fromJson: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet') options.quiet = true;
    else if (arg === '--from-json') {
      options.fromJson = argv[i + 1] ?? '';
      i += 1;
      if (!options.fromJson) throw new Error('--from-json needs a file path (or "-" for stdin).');
    } else if (arg.startsWith('--from-json=')) {
      options.fromJson = arg.slice('--from-json='.length);
      if (!options.fromJson) throw new Error('--from-json needs a file path (or "-" for stdin).');
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const log = (message) => {
    if (!options.quiet) process.stderr.write(`${message}\n`);
  };

  const config = loadConfig();
  if (!config?.data_source_id) {
    throw new Error(`Not configured. Run /notion-skills:setup first (missing ${STATE_DIR}/config.json).`);
  }

  const result = await runSync(config, { fromJson: options.fromJson, log });
  log(
    result.changed
      ? `Updated registry: ${result.count} skills → ${result.path}`
      : `No changes (${result.count} skills).`,
  );
}

// Only run as a CLI; importing this module (setup.mjs, tests) must not sync.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`notion-skills sync failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
