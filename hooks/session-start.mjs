#!/usr/bin/env node
// SessionStart hook: inject the synced skill registry into session context and
// keep it fresh.
//
// Behavior:
//   - not configured        → one-line setup hint
//   - injection: 'off'      → nothing
//   - registry cached       → print it wrapped in routing instructions
//   - cache older than TTL  → spawn a detached background sync (when a script
//                             transport exists) or print a /sync suggestion
//
// This hook must NEVER block or break session start: no network on the hot
// path, all errors swallowed, always exit 0.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { REGISTRY_PATH, loadConfig, parseSyncedAt } from '../scripts/lib.mjs';
import { resolveTransport } from '../scripts/notion.mjs';

const SYNC_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sync.mjs');
const MAX_INJECT_BYTES = 64 * 1024; // safety cap — never flood the context

function main() {
  if (process.env.NOTION_SKILLS_DISABLE) return;

  const config = loadConfig();
  if (!config?.data_source_id) {
    process.stdout.write(
      '[notion-skills] Not configured yet. Run /notion-skills:setup <your Notion skills DB URL> ' +
        'to route requests to skills stored in your Notion database.\n',
    );
    return;
  }
  if (config.injection === 'off') return;

  let registry = '';
  try {
    registry = readFileSync(REGISTRY_PATH, 'utf8');
  } catch {
    process.stdout.write('[notion-skills] Registry not synced yet. Run /notion-skills:sync to build it.\n');
    return;
  }

  const syncedAt = parseSyncedAt(registry);
  const ageHours = syncedAt ? (Date.now() - syncedAt.getTime()) / 3_600_000 : Infinity;
  let staleNote = '';

  if (ageHours > config.ttl_hours) {
    // resolveTransport short-circuits on NOTION_API_TOKEN and returns null for
    // 'mcp' without probing anything, so the only case that costs a subprocess
    // is a token-less 'auto' on an already-stale cache.
    const { transport } = resolveTransport(config.transport);
    staleNote = '(cache may be stale; run /notion-skills:sync to refresh)';

    if (transport) {
      // Refresh for the NEXT session; this one uses the current cache.
      try {
        spawn(process.execPath, [SYNC_SCRIPT, '--quiet'], { detached: true, stdio: 'ignore' }).unref();
        staleNote = `(cache is ${Math.round(ageHours)}h old; a background refresh has started)`;
      } catch {
        /* keep the manual-refresh note */
      }
    }
  }

  if (registry.length > MAX_INJECT_BYTES) {
    registry = `${registry.slice(0, MAX_INJECT_BYTES)}\n… (truncated — registry too large; see ${REGISTRY_PATH})`;
  }

  process.stdout.write(
    [
      `[notion-skills] The user's custom skill registry, synced from their Notion database ${staleNote}`.trimEnd() + '.',
      'When the user\'s request matches a skill name or trigger keywords below, use the',
      'notion-skill-router skill: fetch that Notion page by its ID and follow the page content as instructions.',
      '<notion-skills-registry>',
      registry.trimEnd(),
      '</notion-skills-registry>',
      '',
    ].join('\n'),
  );
}

try {
  main();
} catch {
  // Never break session start.
}
