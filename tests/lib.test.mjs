import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR is resolved when lib.mjs is first imported, so point it somewhere
// disposable before that happens.
process.env.NOTION_SKILLS_HOME = mkdtempSync(join(tmpdir(), 'notion-skills-lib-'));

const lib = await import('../scripts/lib.mjs');

/** A row as the REST API returns it (token / ntn transports). */
const restPage = (overrides = {}) => ({
  object: 'page',
  id: '11111111-2222-3333-4444-555555555555',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'wlog' }] },
    Trigger: { type: 'rich_text', rich_text: [{ plain_text: '作業ログ, wlog' }] },
    Status: { type: 'status', status: { name: 'active' } },
    Category: { type: 'select', select: { name: 'workflow' } },
    Runtime: { type: 'select', select: { name: 'claude-code' } },
    ...overrides,
  },
});

/** The same row as notion-query-data-sources returns it (mcp transport). */
const mcpRow = (overrides = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  url: 'https://app.notion.com/111111112222333344445555555555555',
  Name: 'wlog',
  Trigger: '作業ログ, wlog',
  Status: 'active',
  Category: 'workflow',
  Runtime: 'claude-code',
  ...overrides,
});

const PROPS = lib.DEFAULT_CONFIG.properties;

describe('isRestPage', () => {
  test('recognises a REST page object', () => {
    assert.equal(lib.isRestPage(restPage()), true);
  });

  test('recognises a REST page even without the object discriminator', () => {
    const page = restPage();
    delete page.object;
    assert.equal(lib.isRestPage(page), true);
  });

  test('treats a flat MCP row as not-REST', () => {
    assert.equal(lib.isRestPage(mcpRow()), false);
  });

  test('treats an MCP row with a literal "properties" column as not-REST', () => {
    // A user column named "properties" holds a scalar, not Notion property objects.
    assert.equal(lib.isRestPage(mcpRow({ properties: 'some text' })), false);
  });

  test('does not throw on junk', () => {
    for (const value of [null, undefined, 42, 'text', [], {}]) {
      assert.equal(lib.isRestPage(value), false);
    }
  });
});

describe('normalizeRow', () => {
  test('REST and MCP shapes normalize to the same fields', () => {
    const fromRest = lib.normalizeRow(restPage(), PROPS);
    const fromMcp = lib.normalizeRow(mcpRow(), PROPS);
    assert.deepEqual(fromRest, fromMcp);
    assert.deepEqual(fromRest, {
      id: '11111111-2222-3333-4444-555555555555',
      name: 'wlog',
      trigger: '作業ログ, wlog',
      status: 'active',
      category: 'workflow',
      runtime: 'claude-code',
    });
  });

  test('returns null when the row carries no id', () => {
    const { id, ...withoutId } = mcpRow();
    assert.equal(id.length, 36);
    assert.equal(lib.normalizeRow(withoutId, PROPS), null);
    assert.equal(lib.normalizeRow({ ...withoutId, id: '   ' }, PROPS), null);
  });

  test('missing optional columns become empty strings, not undefined', () => {
    const row = lib.normalizeRow({ id: 'abc', Name: 'solo' }, PROPS);
    assert.deepEqual(row, { id: 'abc', name: 'solo', trigger: '', status: '', category: '', runtime: '' });
  });

  test('null MCP values (the shape Notion returns for an empty select) become empty', () => {
    const row = lib.normalizeRow(mcpRow({ Category: null, Runtime: null }), PROPS);
    assert.equal(row.category, '');
    assert.equal(row.runtime, '');
  });

  test('multi-value columns collapse to a comma list in both shapes', () => {
    const rest = lib.normalizeRow(
      restPage({ Category: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] } }),
      PROPS,
    );
    const mcp = lib.normalizeRow(mcpRow({ Category: ['a', 'b'] }), PROPS);
    assert.equal(rest.category, 'a, b');
    assert.equal(mcp.category, 'a, b');
  });

  test('honours a remapped property name (Japanese schema)', () => {
    const props = { ...PROPS, name: 'スキル名', trigger: '発火条件' };
    const row = lib.normalizeRow({ id: 'x1', スキル名: 'テスト', 発火条件: 'きっかけ' }, props);
    assert.equal(row.name, 'テスト');
    assert.equal(row.trigger, 'きっかけ');
  });

  test('collapses whitespace in both shapes', () => {
    const rest = lib.normalizeRow(restPage({ Name: { type: 'title', title: [{ plain_text: ' a \n b ' }] } }), PROPS);
    const mcp = lib.normalizeRow(mcpRow({ Name: ' a \n b ' }), PROPS);
    assert.equal(rest.name, 'a b');
    assert.equal(mcp.name, 'a b');
  });
});

describe('rowsFromPayload', () => {
  test('accepts a bare array', () => {
    assert.deepEqual(lib.rowsFromPayload([{ id: 'a' }]), [{ id: 'a' }]);
  });

  test('accepts a results envelope (both REST and MCP use one)', () => {
    assert.deepEqual(lib.rowsFromPayload({ results: [{ id: 'a' }], has_more: false }), [{ id: 'a' }]);
  });

  test('refuses a truncated page rather than writing a short registry', () => {
    assert.throws(
      () => lib.rowsFromPayload({ results: [{ id: 'a' }], has_more: true }),
      /only the first page/,
    );
  });

  test('reports the keys it actually got when results is missing', () => {
    assert.throws(() => lib.rowsFromPayload({ data: [] }), /got keys: data/);
  });

  test('rejects non-objects', () => {
    for (const value of [null, 'text', 7]) {
      assert.throws(() => lib.rowsFromPayload(value), /Expected a JSON array/);
    }
  });
});

describe('parseNotionId', () => {
  const id = '0123456789abcdef0123456789abcdef';

  test('extracts from a plain id, a dashed uuid, and a URL', () => {
    assert.equal(lib.parseNotionId(id), id);
    assert.equal(lib.parseNotionId(lib.dashed(id)), id);
    assert.equal(lib.parseNotionId(`https://www.notion.so/${id}`), id);
    assert.equal(lib.parseNotionId(`https://www.notion.so/workspace/Agent-Skills-${id}?v=abc`), id);
  });

  test('takes the last id when a URL carries several (page id wins over workspace id)', () => {
    const other = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
    assert.equal(lib.parseNotionId(`https://notion.so/${other}/${id}`), id);
  });

  test('ignores the ?v= view id — the shape Notion puts on the clipboard', () => {
    // A view id is 32 hex as well, and it comes *after* the database id. Reading
    // the whole string configures the plugin against the view, which then fails
    // to resolve. This is the ordinary copy-the-URL case, not an edge case.
    const view = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
    assert.notEqual(view, id);
    assert.equal(lib.parseNotionId(`https://www.notion.so/ws/Agent-Skills-${id}?v=${view}`), id);
    assert.equal(lib.parseNotionId(`https://www.notion.so/ws/${id}?v=${view}&pvs=4`), id);
    assert.equal(lib.parseNotionId(`https://www.notion.so/ws/${lib.dashed(id)}?v=${view}`), id);
    assert.equal(lib.parseNotionId(`https://www.notion.so/ws/${id}#${view}`), id);
  });

  test('a page title made of hex letters does not shift the match', () => {
    // "CafeBabe" is eight hex digits. Stripping dashes first would glue it to the
    // id and return a 32-char window straddling both.
    assert.equal(lib.parseNotionId(`https://www.notion.so/Cafe-Babe-${id}`), id);
    assert.equal(lib.parseNotionId(`https://www.notion.so/ws/dead-beef-cafe-${id}`), id);
  });

  test('a dashed uuid inside a URL is read as one id, not as fragments', () => {
    assert.equal(lib.parseNotionId(`https://www.notion.so/ws/Skills-${lib.dashed(id)}`), id);
  });

  test('returns empty for input with no id', () => {
    for (const value of ['', 'https://notion.so/', 'not-an-id', null, undefined]) {
      assert.equal(lib.parseNotionId(value), '');
    }
  });

  test('lowercases', () => {
    assert.equal(lib.parseNotionId(id.toUpperCase()), id);
  });
});

describe('dashed / dashless', () => {
  test('round-trips', () => {
    const id = '0123456789abcdef0123456789abcdef';
    assert.equal(lib.dashed(id), '01234567-89ab-cdef-0123-456789abcdef');
    assert.equal(lib.dashless(lib.dashed(id)), id);
  });

  test('leaves an unrecognised length untouched rather than corrupting it', () => {
    assert.equal(lib.dashed('short'), 'short');
  });
});

describe('renderRegistry / parseSyncedAt', () => {
  const rows = [{ id: 'aaaa-bbbb', name: 'x', runtime: 'any', category: 'c', trigger: 't' }];

  test('header carries the sync timestamp and count, and parses back', () => {
    const iso = '2026-08-22T01:02:03.000Z';
    const text = lib.renderRegistry(rows, 'ds-1', iso);
    assert.match(text, /count: 1/);
    assert.match(text, /source: ds-1/);
    assert.equal(lib.parseSyncedAt(text).toISOString(), iso);
  });

  test('escapes literal pipes so a field cannot forge a column', () => {
    const text = lib.renderRegistry(
      [{ id: 'a', name: 'we | ird', runtime: 'any', category: '-', trigger: 'a | b' }],
      'ds',
      new Date().toISOString(),
    );
    const line = text.split('\n').find((l) => !l.startsWith('<!--'));
    assert.equal(line.split(/(?<!\\)\|/).length, 5);
  });

  test('parseSyncedAt returns null for a missing or unparseable header', () => {
    assert.equal(lib.parseSyncedAt('no header here'), null);
    assert.equal(lib.parseSyncedAt('<!-- synced: not-a-date -->'), null);
  });
});

describe('excludedPageIds', () => {
  const id = '0123456789abcdef0123456789abcdef';

  test('normalizes dashes and case so either form matches', () => {
    const set = lib.excludedPageIds({ excluded_pages: ['AAAA-BBBB', ' ccccdddd '] });
    assert.ok(set.has('aaaabbbb'));
    assert.ok(set.has('ccccdddd'));
  });

  test('accepts a pasted page URL, which is what a user has to hand', () => {
    const set = lib.excludedPageIds({
      excluded_pages: [`https://www.notion.so/ws/Reference-${id}?pvs=4`, lib.dashed(id).toUpperCase()],
    });
    assert.deepEqual([...set], [id]);
  });

  test('keeps unrecognisable entries so the "not found" warning can name them', () => {
    assert.ok(lib.excludedPageIds({ excluded_pages: ['oops'] }).has('oops'));
  });

  test('tolerates a missing key', () => {
    assert.equal(lib.excludedPageIds({}).size, 0);
  });
});
