import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NOTION_SKILLS_HOME = mkdtempSync(join(tmpdir(), 'notion-skills-setup-'));

const { parseArgs, resolveDataSourceId, columnsOf, checkSchema, summarize, isNotFound } = await import(
  '../scripts/setup.mjs'
);
const { DEFAULT_CONFIG } = await import('../scripts/lib.mjs');

describe('parseArgs', () => {
  test('takes the database target positionally', () => {
    assert.equal(parseArgs(['https://notion.so/abc']).target, 'https://notion.so/abc');
  });

  test('accepts --flag value and --flag=value alike', () => {
    for (const argv of [['--transport', 'ntn'], ['--transport=ntn']]) {
      assert.equal(parseArgs(argv).transport, 'ntn', argv.join(' '));
    }
  });

  test('collects repeatable property mappings', () => {
    const { properties } = parseArgs(['--property', 'name=スキル名', '--property=trigger=発火条件']);
    assert.deepEqual(properties, { name: 'スキル名', trigger: '発火条件' });
  });

  test('rejects an unknown property key instead of writing a mapping that matches nothing', () => {
    assert.throws(() => parseArgs(['--property', 'nmae=X']), /Unknown property key "nmae"/);
    // The error names the valid keys.
    for (const key of Object.keys(DEFAULT_CONFIG.properties)) {
      assert.throws(() => parseArgs(['--property', 'nmae=X']), new RegExp(key));
    }
  });

  test('rejects a property mapping with no column name', () => {
    assert.throws(() => parseArgs(['--property', 'name=']), /needs a column name/);
    assert.throws(() => parseArgs(['--property', 'name']), /expects key=name/);
  });

  test('rejects an unknown transport and names the valid ones', () => {
    assert.throws(() => parseArgs(['--transport', 'smoke-signal']), /Unknown transport/);
    assert.throws(() => parseArgs(['--transport', 'smoke-signal']), /mcp/);
  });

  test('accepts every documented transport', () => {
    for (const name of ['auto', 'token', 'ntn', 'mcp']) {
      assert.equal(parseArgs(['--transport', name]).transport, name);
    }
  });

  test('validates --injection and --ttl-hours rather than writing junk into the config', () => {
    assert.equal(parseArgs(['--injection', 'off']).injection, 'off');
    assert.throws(() => parseArgs(['--injection', 'maybe']), /expects session or off/);
    assert.equal(parseArgs(['--ttl-hours', '6']).ttlHours, 6);
    for (const bad of ['0', '-1', 'soon']) {
      assert.throws(() => parseArgs(['--ttl-hours', bad]), /positive number/, bad);
    }
  });

  test('--exclude-page accepts a URL or an id and stores the bare id', () => {
    const id = '0123456789abcdef0123456789abcdef';
    const { excludePages } = parseArgs(['--exclude-page', `https://notion.so/x-${id}`, '--exclude-page', id]);
    assert.deepEqual(excludePages, [id, id]);
  });

  test('--exclude-page rejects input with no id in it', () => {
    assert.throws(() => parseArgs(['--exclude-page', 'nonsense']), /expects a Notion page id/);
  });

  test('boolean flags need no value', () => {
    const options = parseArgs(['abc', '--dry-run', '--json']);
    assert.equal(options.dryRun, true);
    assert.equal(options.json, true);
    assert.equal(options.target, 'abc');
  });

  test('rejects a value-taking flag left empty', () => {
    assert.throws(() => parseArgs(['--transport']), /needs a value/);
    assert.throws(() => parseArgs(['--data-source-id', '--json']), /needs a value/);
    assert.throws(() => parseArgs(['--transport=']), /needs a value/);
  });

  test('rejects unknown flags and a second positional', () => {
    assert.throws(() => parseArgs(['--nope']), /Unknown argument: --nope/);
    assert.throws(() => parseArgs(['a', 'b']), /Unexpected extra argument: b/);
  });
});

describe('resolveDataSourceId', () => {
  const dbId = '0123456789abcdef0123456789abcdef';
  const dsId = '00000000-1111-2222-3333-444444444444';
  const notFound = () => {
    throw new Error('Notion API 404: {"object":"error","code":"object_not_found"}');
  };

  test('resolves a database id to its data source', async () => {
    const result = await resolveDataSourceId(`https://notion.so/Agent-Skills-${dbId}`, {
      deps: {
        getDatabase: async () => ({ data_sources: [{ id: dsId }], title: [{ plain_text: 'Agent Skills' }] }),
        probeDataSource: async () => assert.fail('should not probe when the database resolved'),
      },
    });
    assert.equal(result.dataSourceId, dsId);
    assert.equal(result.via, 'database');
    assert.equal(result.title, 'Agent Skills');
  });

  test('refuses to guess when a database has several data sources', async () => {
    // Silently taking the first one syncs whichever table Notion happens to list
    // first, and every later error then describes a database the user never chose.
    await assert.rejects(
      () =>
        resolveDataSourceId(dbId, {
          deps: {
            getDatabase: async () => ({
              data_sources: [{ id: dsId, name: 'Tasks' }, { id: 'other-id', name: 'Skills' }],
            }),
            probeDataSource: async () => assert.fail('must not probe'),
          },
        }),
      (error) => {
        assert.match(error.message, /2 data sources/);
        assert.match(error.message, /--data-source-id/);
        // Both ids and both names, so the choice can actually be made.
        assert.match(error.message, new RegExp(dsId));
        assert.match(error.message, /other-id/);
        assert.match(error.message, /Skills/);
        return true;
      },
    );
  });

  test('falls back to treating the id as a data source when the database is not found', async () => {
    let probed = '';
    let probeCalls = 0;
    const result = await resolveDataSourceId(dsId, {
      deps: {
        getDatabase: notFound,
        probeDataSource: async (id) => {
          probed = id;
          probeCalls += 1;
          return { results: [], has_more: false };
        },
      },
    });
    assert.equal(result.via, 'data-source');
    assert.equal(result.dataSourceId, dsId);
    assert.equal(probed, dsId, 'the probe must use the dashed form the API expects');
    assert.equal(probeCalls, 1, 'the probe must be a single request, not a paginated walk');
  });

  test('preserves a non-404 failure instead of retrying it as a data source', async () => {
    // Retrying turns "your token cannot see this" into "this is not a valid data
    // source", which sends the user after the wrong problem.
    for (const real of [
      'Notion API 401: {"code":"unauthorized"}',
      'Notion API 403: {"code":"restricted_resource"}',
      'Notion API 429: {"code":"rate_limited"}',
      'Notion API 502: bad gateway',
    ]) {
      await assert.rejects(
        () =>
          resolveDataSourceId(dbId, {
            deps: {
              getDatabase: async () => {
                throw new Error(real);
              },
              probeDataSource: async () => assert.fail(`must not probe after: ${real}`),
            },
          }),
        (error) => {
          assert.equal(error.message, real);
          return true;
        },
      );
    }
  });

  test('propagates the probe failure when the id is neither', async () => {
    await assert.rejects(
      () =>
        resolveDataSourceId(dbId, {
          deps: {
            getDatabase: notFound,
            probeDataSource: async () => {
              throw new Error('Notion API 404: object_not_found');
            },
          },
        }),
      /object_not_found/,
    );
  });

  test('rejects input with no Notion id before making any call', async () => {
    await assert.rejects(
      () =>
        resolveDataSourceId('https://example.com/nothing', {
          deps: {
            getDatabase: async () => assert.fail('must not call out for un-parseable input'),
            probeDataSource: async () => assert.fail('must not call out for un-parseable input'),
          },
        }),
      /Could not find a Notion id/,
    );
  });
});

describe('isNotFound', () => {
  test('recognises the shapes that mean "no such database"', () => {
    for (const message of ['Notion API 404: x', 'object_not_found', 'validation_error']) {
      assert.equal(isNotFound(new Error(message)), true, message);
    }
  });

  test('does not treat auth, rate limiting or outages as not-found', () => {
    for (const message of ['Notion API 401: x', 'Notion API 403: x', 'Notion API 429: x', 'Notion API 500: x']) {
      assert.equal(isNotFound(new Error(message)), false, message);
    }
  });

  test('tolerates junk', () => {
    for (const value of [null, undefined, {}, 'text']) assert.equal(isNotFound(value), false);
  });
});

describe('columnsOf', () => {
  test('reads property names from a REST page', () => {
    const page = { object: 'page', id: 'x', properties: { Name: { type: 'title' }, Trigger: { type: 'rich_text' } } };
    assert.deepEqual(columnsOf(page).sort(), ['Name', 'Trigger']);
  });

  test('reads column names from an MCP row, minus the structural keys', () => {
    const row = { id: 'x', url: 'https://…', object: 'page', Name: 'a', Trigger: 'b' };
    assert.deepEqual(columnsOf(row).sort(), ['Name', 'Trigger']);
  });

  test('tolerates junk', () => {
    for (const value of [null, undefined, 'text', 7]) assert.deepEqual(columnsOf(value), []);
  });
});

describe('checkSchema', () => {
  const props = DEFAULT_CONFIG.properties;

  test('a complete schema reports nothing missing', () => {
    const rows = [{ id: 'x', Name: 'a', Trigger: 'b', Status: 'active', Category: 'c', Runtime: 'any' }];
    const result = checkSchema(rows, props);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.fatal, []);
  });

  test('a missing title column is fatal — that is the "registry came out empty" case', () => {
    const result = checkSchema([{ id: 'x', スキル名: 'a' }], props);
    assert.deepEqual(result.fatal.map((m) => m.key), ['name']);
    assert.ok(result.columns.includes('スキル名'));
  });

  test('missing optional columns are reported but not fatal', () => {
    const result = checkSchema([{ id: 'x', Name: 'a' }], props);
    assert.deepEqual(result.fatal, []);
    assert.deepEqual(result.optional.map((m) => m.key).sort(), ['category', 'runtime', 'status', 'trigger']);
  });

  test('columns are unioned across rows, since Notion omits nothing but a row may', () => {
    const result = checkSchema([{ id: 'a', Name: 'x' }, { id: 'b', Trigger: 'y' }], props);
    assert.deepEqual(result.fatal, []);
    assert.ok(result.columns.includes('Name') && result.columns.includes('Trigger'));
  });

  test('a remapped schema validates against the mapped names', () => {
    const mapped = { ...props, name: 'スキル名' };
    assert.deepEqual(checkSchema([{ id: 'x', スキル名: 'a' }], mapped).fatal, []);
  });
});

describe('summarize', () => {
  const rows = [
    { name: 'a', category: 'workflow', runtime: 'any', trigger: 't' },
    { name: 'b', category: 'workflow', runtime: 'claude-code', trigger: '' },
    { name: 'c', category: '', runtime: 'any', trigger: 't' },
  ];

  test('counts totals, categories and runtimes instead of listing every skill', () => {
    const summary = summarize(rows);
    assert.equal(summary.total, 3);
    assert.deepEqual(summary.categories, [
      { name: 'workflow', count: 2 },
      { name: '(none)', count: 1 },
    ]);
    assert.deepEqual(summary.runtimes, [
      { name: 'any', count: 2 },
      { name: 'claude-code', count: 1 },
    ]);
    assert.equal(summary.without_trigger, 1);
  });

  test('the summary size does not grow with the number of skills', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      name: `skill-${i}`,
      category: 'workflow',
      runtime: 'any',
      trigger: 't',
    }));
    const summary = summarize(many);
    assert.equal(summary.total, 500);
    assert.equal(summary.categories.length, 1);
    assert.ok(JSON.stringify(summary).length < 400, 'summary must stay compact for large stores');
  });

  test('handles an empty set', () => {
    assert.deepEqual(summarize([]), { total: 0, categories: [], runtimes: [], without_trigger: 0 });
  });
});
