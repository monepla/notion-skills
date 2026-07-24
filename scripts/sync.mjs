#!/usr/bin/env node
// Sync the user's Notion Skills DB into the local registry cache.
//
//   node scripts/sync.mjs            sync and write ~/.claude/notion-skills/registry.md
//   node scripts/sync.mjs --quiet    same, but only errors go to stderr
//
// Requires NOTION_API_TOKEN or the `ntn` CLI. In MCP-only setups the model
// performs this sync instead (skills/sync/SKILL.md documents the same format).

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

import { queryDataSource } from './notion.mjs';
import {
  REGISTRY_PATH,
  STATE_DIR,
  dashless,
  excludedPageIds,
  loadConfig,
  plain,
  renderRegistry,
  selectName,
} from './lib.mjs';

const quiet = process.argv.includes('--quiet');
const log = (message) => {
  if (!quiet) process.stderr.write(`${message}\n`);
};

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const lastComma = Math.max(head.lastIndexOf(','), head.lastIndexOf('、'));
  return `${(lastComma > 0 ? head.slice(0, lastComma) : head).trim()} …`;
}

function buildRows(pages, config) {
  const map = config.properties;
  const excluded = config.excluded_status.map((status) => status.toLowerCase());
  const excludedIds = excludedPageIds(config);
  const seenExcluded = new Set();
  const rows = [];

  for (const page of pages) {
    if (excludedIds.has(dashless(page.id.toLowerCase()))) {
      seenExcluded.add(dashless(page.id.toLowerCase()));
      continue;
    }

    const name = plain(page.properties?.[map.name]);
    if (!name) {
      log(`warn: skipping page with empty ${map.name}: ${page.id}`);
      continue;
    }

    const status = selectName(page.properties?.[map.status]).toLowerCase();
    if (status && excluded.includes(status)) continue;

    const trigger = plain(page.properties?.[map.trigger]);
    if (!trigger) log(`warn: ${name} has no ${map.trigger} — routing will rely on its name only`);

    rows.push({
      id: page.id,
      name,
      // Missing Runtime property (or empty) means the skill is portable.
      runtime: selectName(page.properties?.[map.runtime]).toLowerCase() || 'any',
      category: selectName(page.properties?.[map.category]),
      trigger: truncate(trigger, config.max_trigger_chars),
    });
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

async function main() {
  const config = loadConfig();
  if (!config?.data_source_id) {
    throw new Error(`Not configured. Run /notion-skills:setup first (missing ${STATE_DIR}/config.json).`);
  }

  const pages = await queryDataSource(config.data_source_id);
  const rows = buildRows(pages, config);
  if (rows.length === 0) {
    throw new Error('Registry came out empty — check the database ID and property names in config.json.');
  }

  const output = renderRegistry(rows, config.data_source_id, new Date().toISOString());
  const current = safeRead(REGISTRY_PATH);

  // Always rewrite (the synced timestamp must advance), but report whether the
  // skill list itself changed. Header lines (comments) are excluded from the diff.
  const body = (text) => text.split('\n').filter((line) => !line.startsWith('<!--')).join('\n');

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, output);
  log(
    body(current) === body(output)
      ? `No changes (${rows.length} skills).`
      : `Updated registry: ${rows.length} skills → ${REGISTRY_PATH}`,
  );
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

main().catch((error) => {
  process.stderr.write(`notion-skills sync failed: ${error.message}\n`);
  process.exitCode = 1;
});
