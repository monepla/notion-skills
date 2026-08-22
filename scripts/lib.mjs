// Shared config / registry helpers for the notion-skills plugin.
//
// User state lives OUTSIDE the plugin directory (plugin updates must not
// touch it):
//
//   ~/.claude/notion-skills/config.json    user configuration (no secrets)
//   ~/.claude/notion-skills/registry.md    synced registry cache
//
// Override the directory with NOTION_SKILLS_HOME (used by tests).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export const STATE_DIR = process.env.NOTION_SKILLS_HOME ?? join(homedir(), '.claude', 'notion-skills');
export const CONFIG_PATH = join(STATE_DIR, 'config.json');
export const REGISTRY_PATH = join(STATE_DIR, 'registry.md');

export const DEFAULT_CONFIG = {
  data_source_id: '',
  // 'auto' picks token → ntn → mcp. Set 'mcp' to disable script syncs entirely.
  transport: 'auto',
  ttl_hours: 24,
  // 'session' injects the registry at session start; 'off' disables injection
  // (the router skill then queries Notion directly via MCP).
  injection: 'session',
  // Map of logical fields → property names in the user's database.
  properties: {
    name: 'Name',
    trigger: 'Trigger',
    status: 'Status',
    category: 'Category',
    // Which AI runtimes can execute this skill:
    //   any         portable (knowledge / procedures / Notion operations)
    //   claude-code needs local tools (shell, repo, MCP servers)
    //   notion      Notion AI / Notion Agents only
    // Pages without the property default to 'any'.
    runtime: 'Runtime',
  },
  // Pages whose status matches one of these are excluded (case-insensitive).
  // Pages with NO status are included, so a status property is optional.
  excluded_status: ['archived', 'draft', 'disabled'],
  // Page IDs to keep out of the registry regardless of status — for reference
  // pages, scratch notes, or superseded duplicates that live in the same
  // database but should never be routed to. Dashes are optional.
  excluded_pages: [],
  // Trigger text is truncated to this many characters in the registry.
  max_trigger_chars: 100,
};

/** Load config.json merged over defaults. Returns null if not configured. */
export function loadConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return null;
  }
  const user = JSON.parse(raw);
  return {
    ...DEFAULT_CONFIG,
    ...user,
    properties: { ...DEFAULT_CONFIG.properties, ...(user.properties ?? {}) },
  };
}

/** Plain-text value of a title / rich_text property. */
export function plain(property) {
  const parts = property?.title ?? property?.rich_text ?? [];
  return parts
    .map((part) => part.plain_text ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Name of a select / status / multi_select property. */
export function selectName(property) {
  return (
    property?.select?.name ??
    property?.status?.name ??
    property?.multi_select?.map((option) => option.name).join(', ') ??
    ''
  );
}

/** Collapse an already-flat value (MCP rows) to a trimmed string. */
function scalar(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(scalar).filter(Boolean).join(', ');
  if (typeof value === 'object') return scalar(value.name ?? value.plain_text ?? '');
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * A REST page object carries Notion property objects (`{type, title|select|…}`);
 * an MCP `notion-query-data-sources` row carries plain scalars keyed by column
 * name. Telling them apart lets one renderer serve every transport.
 */
export function isRestPage(raw) {
  if (raw?.object === 'page') return true;
  const props = raw?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return false;
  return Object.values(props).some((value) => value && typeof value === 'object' && typeof value.type === 'string');
}

/**
 * Normalize one row — REST page object or MCP query row — into the fields the
 * registry needs. Returns null when the row carries no page id, because a
 * registry line without an id can never be fetched again.
 */
export function normalizeRow(raw, properties) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;

  const read = isRestPage(raw)
    ? {
        text: (key) => plain(raw.properties?.[key]),
        choice: (key) => selectName(raw.properties?.[key]),
      }
    : {
        text: (key) => scalar(raw[key]),
        choice: (key) => scalar(raw[key]),
      };

  return {
    id,
    name: read.text(properties.name),
    trigger: read.text(properties.trigger),
    status: read.choice(properties.status),
    category: read.choice(properties.category),
    runtime: read.choice(properties.runtime),
  };
}

/**
 * Unwrap whatever the caller handed us into an array of rows.
 *
 * Accepts a bare array, a Notion REST response (`{results: […]}`), or the MCP
 * query result (same key). `has_more: true` is refused rather than silently
 * writing a short registry: a truncated registry looks exactly like a complete
 * one, and the missing skills simply stop routing.
 */
export function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Expected a JSON array of rows or an object with a "results" array.');
  }
  if (!Array.isArray(payload.results)) {
    throw new Error(`Expected a "results" array; got keys: ${Object.keys(payload).join(', ') || '(none)'}.`);
  }
  if (payload.has_more === true) {
    throw new Error(
      'The supplied rows are only the first page ("has_more": true). Fetch the remaining pages and ' +
        'concatenate them before syncing — a partial registry silently stops routing the missing skills.',
    );
  }
  return payload.results;
}

/** 32-hex Notion id out of a URL, a dashed UUID, or a bare id. */
export function parseNotionId(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';

  // Drop the query string first. The URL Notion puts on the clipboard ends in
  // `?v=<view id>`, and a view id is 32 hex too — searching the whole string
  // would configure the plugin against the view instead of the database.
  const path = text.split(/[?#]/)[0];

  // A dashed UUID is unambiguous, so prefer it.
  const dashedIds = path.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g);
  if (dashedIds) return dashless(dashedIds[dashedIds.length - 1]).toLowerCase();

  // Otherwise a bare 32-hex run, bounded on both sides: without the boundaries a
  // page title that happens to be hex (".../Cafe-Babe-<id>") merges with the id
  // and the match slides off by however many characters the title contributed.
  const bareIds = path.match(/(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/g);
  return bareIds ? bareIds[bareIds.length - 1].toLowerCase() : '';
}

/** 32-char dashless id → 36-char dashed UUID (the form Notion's API expects). */
export function dashed(id) {
  const raw = dashless(String(id).trim().toLowerCase());
  if (raw.length !== 32) return String(id).trim();
  return [raw.slice(0, 8), raw.slice(8, 12), raw.slice(12, 16), raw.slice(16, 20), raw.slice(20)].join('-');
}

/** 36-char dashed UUID → 32-char dashless (registry format). */
export function dashless(id) {
  return id.replace(/-/g, '');
}

/**
 * Set of excluded page IDs, normalized so dashed, dashless and a pasted page URL
 * all match. Anything unrecognisable is kept as-is so it still shows up in the
 * "excluded_pages entry not found" warning rather than vanishing.
 */
export function excludedPageIds(config) {
  return new Set(
    (config.excluded_pages ?? []).map((id) => parseNotionId(id) || dashless(String(id).trim().toLowerCase())),
  );
}

/**
 * Render the registry cache file. One line per skill:
 *   name | id32 | runtime | category | triggers
 * Header carries sync metadata that session-start.mjs parses for staleness.
 */
export function renderRegistry(rows, dataSourceId, syncedAtIso) {
  const lines = [
    `<!-- notion-skills registry | synced: ${syncedAtIso} | count: ${rows.length} | source: ${dataSourceId} -->`,
    '<!-- format: name | page_id (dashless) | runtime | category | trigger keywords -->',
  ];
  for (const row of rows) {
    lines.push(
      [row.name, dashless(row.id), row.runtime || 'any', row.category || '-', row.trigger || '-']
        .map((field) => String(field).replace(/\|/g, '\\|'))
        .join(' | '),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Parse `synced:` timestamp out of a registry file. Returns Date or null. */
export function parseSyncedAt(registryText) {
  const match = registryText.match(/synced: ([0-9T:.Z+-]+)/);
  if (!match) return null;
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? null : date;
}
