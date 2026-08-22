#!/usr/bin/env node
// One-shot setup: resolve the data source, check the schema, write the config,
// and run the first sync.
//
//   node scripts/setup.mjs <database URL or id>
//   node scripts/setup.mjs <id> --property name=スキル名 --property trigger=発火条件
//   node scripts/setup.mjs --data-source-id <id> --from-json rows.json   (MCP path)
//
// Why this exists: the setup skill used to walk the model through resolve →
// probe → detect → mkdir → write → sync as separate tool calls. Each step is a
// round trip, and the work itself is deterministic. Doing it in one process
// turns ~6 round trips into 1; the model only interprets the summary.
//
// Everything user-specific lands in ~/.claude/notion-skills/, never in the
// plugin directory. No token is ever written to disk.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { getDatabase, queryDataSource, resolveTransport, TRANSPORTS } from './notion.mjs';
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  STATE_DIR,
  dashed,
  loadConfig,
  parseNotionId,
  rowsFromPayload,
} from './lib.mjs';
import { buildRows, writeRegistry } from './sync.mjs';

const USAGE = `Usage:
  setup.mjs <notion database URL or id> [options]
  setup.mjs --data-source-id <id> --from-json <file|-> [options]

Options:
  --data-source-id <id>   Use this data source directly (skips resolution)
  --from-json <file|->    Rows already fetched over the Notion MCP connector
  --property <key=name>   Map a logical field to your column name (repeatable):
                          ${Object.keys(DEFAULT_CONFIG.properties).join(', ')}
  --transport <name>      One of: ${TRANSPORTS.join(', ')} (default: auto)
  --injection <mode>      session | off (default: session)
  --ttl-hours <n>         Cache age that triggers a background refresh (default: 24)
  --exclude-page <id>     Keep a page out of the registry (repeatable)
  --dry-run               Report what would happen; write nothing
  --json                  Emit the summary as JSON`;

export function parseArgs(argv) {
  const options = {
    target: '',
    dataSourceId: '',
    fromJson: '',
    properties: {},
    transport: '',
    injection: '',
    ttlHours: null,
    excludePages: [],
    dryRun: false,
    json: false,
  };

  const value = (arg, index) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value.`);
    return next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (options.target) throw new Error(`Unexpected extra argument: ${arg}`);
      options.target = arg;
      continue;
    }

    // Accept --flag=value as well as --flag value.
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const take = () => {
      if (inline !== null) {
        if (!inline) throw new Error(`${flag} needs a value.`);
        return inline;
      }
      const next = value(flag, i);
      i += 1;
      return next;
    };

    switch (flag) {
      case '--data-source-id':
        options.dataSourceId = take();
        break;
      case '--from-json':
        options.fromJson = take();
        break;
      case '--property': {
        const pair = take();
        const split = pair.indexOf('=');
        if (split <= 0) throw new Error(`--property expects key=name, got "${pair}".`);
        const key = pair.slice(0, split).trim();
        const name = pair.slice(split + 1).trim();
        if (!(key in DEFAULT_CONFIG.properties)) {
          throw new Error(
            `Unknown property key "${key}". Expected one of: ${Object.keys(DEFAULT_CONFIG.properties).join(', ')}.`,
          );
        }
        if (!name) throw new Error(`--property ${key}= needs a column name.`);
        options.properties[key] = name;
        break;
      }
      case '--transport': {
        const name = take().toLowerCase();
        if (!['auto', ...TRANSPORTS].includes(name)) {
          throw new Error(`Unknown transport "${name}". Use one of: auto, ${TRANSPORTS.join(', ')}.`);
        }
        options.transport = name;
        break;
      }
      case '--injection': {
        const mode = take().toLowerCase();
        if (!['session', 'off'].includes(mode)) throw new Error(`--injection expects session or off, got "${mode}".`);
        options.injection = mode;
        break;
      }
      case '--ttl-hours': {
        const raw = take();
        const hours = Number(raw);
        if (!Number.isFinite(hours) || hours <= 0) throw new Error(`--ttl-hours expects a positive number, got "${raw}".`);
        options.ttlHours = hours;
        break;
      }
      case '--exclude-page': {
        const id = parseNotionId(take());
        if (!id) throw new Error('--exclude-page expects a Notion page id or URL.');
        options.excludePages.push(id);
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return options;
}

/**
 * A database id and a data_source_id are different things, and the same URL can
 * carry either. Ask Notion which one we were given rather than guessing.
 */
export async function resolveDataSourceId(rawId, { transport, deps = {} } = {}) {
  const id = parseNotionId(rawId);
  if (!id) throw new Error(`Could not find a Notion id in "${rawId}".`);

  const fetchDatabase = deps.getDatabase ?? getDatabase;
  const probe = deps.queryDataSource ?? queryDataSource;

  try {
    const database = await fetchDatabase(dashed(id), { transport });
    const first = database?.data_sources?.[0]?.id;
    if (first) {
      return {
        dataSourceId: first,
        via: 'database',
        title: database?.title?.map((part) => part.plain_text ?? '').join('') || '',
        multiple: (database?.data_sources ?? []).length > 1,
      };
    }
  } catch {
    // Not a database id (typically a 404) — fall through and try it as a data source.
  }

  // If a single-row query succeeds, the id we were handed already is a data source.
  await probe(dashed(id), { transport, pageSize: 1 });
  return { dataSourceId: dashed(id), via: 'data-source', title: '', multiple: false };
}

/** Column names present on a row, for both REST pages and MCP rows. */
export function columnsOf(row) {
  if (!row || typeof row !== 'object') return [];
  const properties = row.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) return Object.keys(properties);
  return Object.keys(row).filter((key) => !['id', 'url', 'object', 'parent'].includes(key));
}

/**
 * Compare the configured property map against the columns the database really
 * has. `name` missing is fatal — that is the "registry came out empty" case,
 * and it is far cheaper to say so here than after a full sync.
 */
export function checkSchema(rows, properties) {
  const columns = new Set(rows.flatMap(columnsOf));
  const missing = Object.entries(properties)
    .filter(([, column]) => !columns.has(column))
    .map(([key, column]) => ({ key, column }));

  return {
    columns: [...columns],
    missing,
    fatal: missing.filter(({ key }) => key === 'name'),
    optional: missing.filter(({ key }) => key !== 'name'),
  };
}

/** Categories → count, for a compact summary that does not re-list every skill. */
export function summarize(rows) {
  const byCategory = new Map();
  const byRuntime = new Map();
  for (const row of rows) {
    const category = row.category || '(none)';
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    byRuntime.set(row.runtime, (byRuntime.get(row.runtime) ?? 0) + 1);
  }
  const sort = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'));
  return {
    total: rows.length,
    categories: sort(byCategory).map(([name, count]) => ({ name, count })),
    runtimes: sort(byRuntime).map(([name, count]) => ({ name, count })),
    without_trigger: rows.filter((row) => !row.trigger).length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.target && !options.dataSourceId)) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const warnings = [];
  const log = (message) => warnings.push(message);

  const requested = options.transport || 'auto';
  const { transport: scriptTransport, reason } = resolveTransport(requested);

  // MCP has no script transport by design; it must supply rows instead.
  if (!scriptTransport && !options.fromJson) throw new Error(reason);

  // Resolving a database id → data_source_id needs a live API call, which the
  // MCP path cannot make from here. The model already knows the id in that case
  // (it fetched the database to get the rows), so ask for it outright.
  if (!options.dataSourceId && !scriptTransport) {
    throw new Error(
      'Without a token or the ntn CLI, the data source id cannot be resolved here. ' +
        'Fetch the database over MCP and re-run with --data-source-id <collection id>.',
    );
  }

  const dataSourceId = options.dataSourceId
    ? dashed(parseNotionId(options.dataSourceId) || options.dataSourceId)
    : (await resolveDataSourceId(options.target, { transport: requested })).dataSourceId;

  const existing = loadConfig() ?? {};
  const config = {
    ...DEFAULT_CONFIG,
    ...existing,
    data_source_id: dataSourceId,
    transport: options.transport || (options.fromJson && !scriptTransport ? 'mcp' : existing.transport || 'auto'),
    injection: options.injection || existing.injection || DEFAULT_CONFIG.injection,
    ttl_hours: options.ttlHours ?? existing.ttl_hours ?? DEFAULT_CONFIG.ttl_hours,
    properties: { ...DEFAULT_CONFIG.properties, ...(existing.properties ?? {}), ...options.properties },
    excluded_pages: options.excludePages.length ? options.excludePages : (existing.excluded_pages ?? []),
  };

  const rawRows = options.fromJson
    ? rowsFromPayload(JSON.parse(readSource(options.fromJson)))
    : await queryDataSource(dataSourceId, { transport: config.transport });

  const schema = checkSchema(rawRows, config.properties);
  if (schema.fatal.length) {
    throw new Error(
      `The database has no "${config.properties.name}" column (its columns: ${schema.columns.join(', ') || 'none'}). ` +
        'Re-run with --property name=<your title column>.',
    );
  }
  for (const { key, column } of schema.optional) {
    log(`note: no "${column}" column for ${key} — using the default for every skill`);
  }

  const rows = buildRows(rawRows, config, log);
  if (rows.length === 0) {
    throw new Error(
      `Every one of the ${rawRows.length} row(s) was filtered out. Check excluded_status ` +
        `(${config.excluded_status.join(', ')}) and the property mapping in ${CONFIG_PATH}.`,
    );
  }

  const summary = {
    config_path: CONFIG_PATH,
    data_source_id: dataSourceId,
    transport: config.transport,
    effective_transport: scriptTransport ?? 'mcp',
    auto_refresh: Boolean(scriptTransport),
    ...summarize(rows),
    warnings,
    dry_run: options.dryRun,
  };

  if (!options.dryRun) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
    summary.registry_path = writeRegistry(rows, config).path;
  }

  process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `${render(summary)}\n`);
}

function render(summary) {
  const lines = [
    summary.dry_run ? 'notion-skills setup (dry run — nothing written)' : 'notion-skills setup complete',
    `  skills registered : ${summary.total}`,
    `  data source       : ${summary.data_source_id}`,
    `  transport         : ${summary.effective_transport}${
      summary.auto_refresh ? ' (background refresh on)' : ' (refresh with /notion-skills:sync)'
    }`,
    `  config            : ${summary.config_path}`,
  ];
  if (summary.registry_path) lines.push(`  registry          : ${summary.registry_path}`);
  lines.push(`  categories        : ${summary.categories.map((c) => `${c.name} ${c.count}`).join(', ') || '(none)'}`);
  lines.push(`  runtimes          : ${summary.runtimes.map((r) => `${r.name} ${r.count}`).join(', ')}`);
  if (summary.without_trigger) lines.push(`  without trigger   : ${summary.without_trigger}`);
  for (const warning of summary.warnings) lines.push(`  ${warning}`);
  return lines.join('\n');
}

function readSource(path) {
  return readFileSync(path === '-' ? 0 : path, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`notion-skills setup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
