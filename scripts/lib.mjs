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
  },
  // Pages whose status matches one of these are excluded (case-insensitive).
  // Pages with NO status are included, so a status property is optional.
  excluded_status: ['archived', 'draft', 'disabled'],
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

/** 36-char dashed UUID → 32-char dashless (registry format). */
export function dashless(id) {
  return id.replace(/-/g, '');
}

/**
 * Render the registry cache file. One line per skill:
 *   name | id32 | category | triggers
 * Header carries sync metadata that session-start.mjs parses for staleness.
 */
export function renderRegistry(rows, dataSourceId, syncedAtIso) {
  const lines = [
    `<!-- notion-skills registry | synced: ${syncedAtIso} | count: ${rows.length} | source: ${dataSourceId} -->`,
    '<!-- format: name | page_id (dashless) | category | trigger keywords -->',
  ];
  for (const row of rows) {
    lines.push(
      [row.name, dashless(row.id), row.category || '-', row.trigger || '-']
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
