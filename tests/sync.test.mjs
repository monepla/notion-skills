import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'notion-skills-sync-'));
process.env.NOTION_SKILLS_HOME = HOME;

const { DEFAULT_CONFIG, REGISTRY_PATH } = await import('../scripts/lib.mjs');
const { buildRows, writeRegistry, collectRows, runSync } = await import('../scripts/sync.mjs');

const config = (overrides = {}) => ({ ...DEFAULT_CONFIG, data_source_id: 'ds-test', ...overrides });

const rest = (id, name, extra = {}) => ({
  object: 'page',
  id,
  properties: {
    Name: { type: 'title', title: [{ plain_text: name }] },
    Trigger: { type: 'rich_text', rich_text: [{ plain_text: `${name} trigger` }] },
    Status: { type: 'status', status: { name: 'active' } },
    Category: { type: 'select', select: { name: 'workflow' } },
    Runtime: { type: 'select', select: { name: 'any' } },
    ...extra,
  },
});

const mcp = (id, name, extra = {}) => ({
  id,
  Name: name,
  Trigger: `${name} trigger`,
  Status: 'active',
  Category: 'workflow',
  Runtime: 'any',
  ...extra,
});

describe('buildRows: REST and MCP inputs produce identical registries', () => {
  test('same rows either way', () => {
    const restRows = buildRows([rest('id-1', 'alpha'), rest('id-2', 'beta')], config());
    const mcpRows = buildRows([mcp('id-1', 'alpha'), mcp('id-2', 'beta')], config());
    assert.deepEqual(restRows, mcpRows);
    assert.equal(restRows.length, 2);
  });

  test('a mixed batch is handled row by row', () => {
    const rows = buildRows([rest('id-1', 'alpha'), mcp('id-2', 'beta')], config());
    assert.deepEqual(rows.map((r) => r.name), ['alpha', 'beta']);
  });
});

describe('buildRows: filtering', () => {
  test('excluded_status drops matching rows, case-insensitively', () => {
    const rows = buildRows(
      [mcp('id-1', 'kept'), mcp('id-2', 'gone', { Status: 'Archived' }), mcp('id-3', 'draft', { Status: 'DRAFT' })],
      config(),
    );
    assert.deepEqual(rows.map((r) => r.name), ['kept']);
  });

  test('rows with no status are kept (the property is optional)', () => {
    const rows = buildRows([mcp('id-1', 'kept', { Status: null })], config());
    assert.equal(rows.length, 1);
  });

  test('excluded_pages drops by id regardless of status, matching dashed or dashless', () => {
    const dashedId = '11111111-2222-3333-4444-555555555555';
    const rows = buildRows(
      [mcp(dashedId, 'gone'), mcp('id-2', 'kept')],
      config({ excluded_pages: ['111111112222333344445555555555 55'.replace(/ /g, '')] }),
    );
    assert.deepEqual(rows.map((r) => r.name), ['kept']);
  });

  test('rows with an empty name are skipped with a warning', () => {
    const warnings = [];
    const rows = buildRows([mcp('id-1', ''), mcp('id-2', 'kept')], config(), (m) => warnings.push(m));
    assert.deepEqual(rows.map((r) => r.name), ['kept']);
    assert.ok(warnings.some((w) => w.includes('empty Name')), warnings.join('\n'));
  });
});

describe('buildRows: warnings surface problems instead of hiding them', () => {
  test('warns about a skill with no trigger but keeps it', () => {
    const warnings = [];
    const rows = buildRows([mcp('id-1', 'lonely', { Trigger: '' })], config(), (m) => warnings.push(m));
    assert.equal(rows.length, 1);
    assert.ok(warnings.some((w) => w.includes('has no Trigger')), warnings.join('\n'));
  });

  test('warns about duplicate names', () => {
    const warnings = [];
    buildRows([mcp('id-1', 'dup'), mcp('id-2', 'dup')], config(), (m) => warnings.push(m));
    assert.ok(warnings.some((w) => w.includes('duplicate skill name "dup"')), warnings.join('\n'));
  });

  test('warns when an excluded_pages entry matches nothing', () => {
    const warnings = [];
    buildRows([mcp('id-1', 'a')], config({ excluded_pages: ['deadbeef'] }), (m) => warnings.push(m));
    assert.ok(warnings.some((w) => w.includes('excluded_pages entry not found')), warnings.join('\n'));
  });
});

describe('buildRows: rows without an id are fatal, not silently dropped', () => {
  test('throws and names the MCP cause', () => {
    const { id, ...noId } = mcp('id-1', 'alpha');
    assert.equal(typeof id, 'string');
    assert.throws(() => buildRows([noId], config()), /carry no page id/);
    assert.throws(() => buildRows([noId], config()), /include `id` in the SELECT/);
  });

  test('one bad row fails the whole sync rather than shipping a short registry', () => {
    const { id, ...noId } = mcp('id-2', 'beta');
    assert.equal(typeof id, 'string');
    assert.throws(() => buildRows([mcp('id-1', 'alpha'), noId], config()), /1 row\(s\) carry no page id/);
  });
});

describe('buildRows: defaults and formatting', () => {
  test('missing runtime defaults to "any" and is lowercased', () => {
    const rows = buildRows([mcp('id-1', 'a', { Runtime: null }), mcp('id-2', 'b', { Runtime: 'Claude-Code' })], config());
    assert.equal(rows.find((r) => r.name === 'a').runtime, 'any');
    assert.equal(rows.find((r) => r.name === 'b').runtime, 'claude-code');
  });

  test('trigger text is truncated on a comma boundary', () => {
    const trigger = `${'a'.repeat(40)}, ${'b'.repeat(40)}, ${'c'.repeat(40)}`;
    const [row] = buildRows([mcp('id-1', 'x', { Trigger: trigger })], config({ max_trigger_chars: 50 }));
    assert.ok(row.trigger.endsWith(' …'), row.trigger);
    assert.ok(row.trigger.length <= 52, `${row.trigger.length}`);
    assert.ok(!row.trigger.includes('ccc'));
  });

  test('a Japanese comma is also a truncation boundary', () => {
    const trigger = `${'あ'.repeat(30)}、${'い'.repeat(30)}`;
    const [row] = buildRows([mcp('id-1', 'x', { Trigger: trigger })], config({ max_trigger_chars: 40 }));
    assert.ok(row.trigger.endsWith(' …'));
    assert.ok(!row.trigger.includes('い'));
  });

  test('short triggers are left alone', () => {
    const [row] = buildRows([mcp('id-1', 'x', { Trigger: 'short' })], config());
    assert.equal(row.trigger, 'short');
  });

  test('rows sort by category then name', () => {
    const rows = buildRows(
      [
        mcp('id-1', 'zeta', { Category: 'aaa' }),
        mcp('id-2', 'alpha', { Category: 'zzz' }),
        mcp('id-3', 'beta', { Category: 'aaa' }),
      ],
      config(),
    );
    assert.deepEqual(rows.map((r) => r.name), ['beta', 'zeta', 'alpha']);
  });
});

describe('writeRegistry', () => {
  test('reports changed on first write and unchanged on an identical rewrite', () => {
    const rows = buildRows([mcp('id-1', 'alpha')], config());
    const first = writeRegistry(rows, config(), new Date('2026-01-01T00:00:00Z'));
    assert.equal(first.changed, true);
    assert.equal(first.count, 1);

    // Only the timestamp differs — the skill list is the same, so report no change.
    const second = writeRegistry(rows, config(), new Date('2026-01-02T00:00:00Z'));
    assert.equal(second.changed, false);

    const text = readFileSync(REGISTRY_PATH, 'utf8');
    assert.match(text, /synced: 2026-01-02/);
    assert.match(text, /alpha \| id1 \| any \| workflow/);
  });

  test('a changed skill list is reported as changed', () => {
    writeRegistry(buildRows([mcp('id-1', 'alpha')], config()), config());
    const next = writeRegistry(buildRows([mcp('id-1', 'renamed')], config()), config());
    assert.equal(next.changed, true);
  });
});

describe('collectRows / runSync via --from-json (the MCP path)', () => {
  const payloadPath = join(HOME, 'rows.json');

  test('reads a results envelope from a file', async () => {
    writeFileSync(payloadPath, JSON.stringify({ results: [mcp('id-1', 'alpha')], has_more: false }));
    const rows = await collectRows(config(), payloadPath);
    assert.equal(rows.length, 1);
  });

  test('runSync writes a registry without touching the network', async () => {
    writeFileSync(payloadPath, JSON.stringify({ results: [mcp('id-1', 'alpha'), mcp('id-2', 'beta')] }));
    const result = await runSync(config({ transport: 'mcp' }), { fromJson: payloadPath });
    assert.equal(result.count, 2);
    assert.match(readFileSync(result.path, 'utf8'), /beta \| id2/);
  });

  test('an empty result set is an error, not an empty registry', async () => {
    writeFileSync(payloadPath, JSON.stringify({ results: [] }));
    await assert.rejects(() => runSync(config(), { fromJson: payloadPath }), /came out empty/);
  });

  test('a truncated page is refused', async () => {
    writeFileSync(payloadPath, JSON.stringify({ results: [mcp('id-1', 'a')], has_more: true }));
    await assert.rejects(() => runSync(config(), { fromJson: payloadPath }), /only the first page/);
  });
});
