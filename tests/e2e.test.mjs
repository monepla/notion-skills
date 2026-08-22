// End-to-end: run the shipped scripts as a user would, with no network at all.
// The --from-json path is the MCP transport, so the whole pipeline
// (setup → config → registry → session-start injection) is exercisable offline.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(ROOT, 'scripts', 'setup.mjs');
const SYNC = join(ROOT, 'scripts', 'sync.mjs');
const HOOK = join(ROOT, 'hooks', 'session-start.mjs');
const DS = '00000000-1111-2222-3333-444444444444';

const freshHome = () => mkdtempSync(join(tmpdir(), 'notion-skills-e2e-'));

/**
 * Run a script with a clean environment: no token, no ntn, no ambient config.
 * spawnSync (not execFileSync) so stderr is captured on success too — sync.mjs
 * reports its summary there.
 */
function run(script, args, home, { expectFailure = false, env = {} } = {}) {
  const child = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '', // guarantees `ntn` is unreachable
      NOTION_SKILLS_HOME: home,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = { stdout: child.stdout ?? '', stderr: child.stderr ?? '', status: child.status ?? 1 };
  if (child.error) assert.fail(`${script} failed to start: ${child.error.message}`);
  if (!expectFailure && result.status !== 0) {
    assert.fail(`${script} exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  if (expectFailure && result.status === 0) {
    assert.fail(`${script} unexpectedly succeeded\nstdout: ${result.stdout}`);
  }
  return result;
}

const rowsFile = (home, rows, extra = {}) => {
  const path = join(home, 'rows.json');
  writeFileSync(path, JSON.stringify({ results: rows, has_more: false, ...extra }));
  return path;
};

const row = (id, name, extra = {}) => ({
  id,
  Name: name,
  Trigger: `${name} trigger`,
  Status: 'active',
  Category: 'workflow',
  Runtime: 'any',
  ...extra,
});

describe('setup.mjs: one command does resolve → validate → config → first sync', () => {
  test('writes config and registry, and reports counts rather than every skill', () => {
    const home = freshHome();
    const rows = Array.from({ length: 60 }, (_, i) => row(`id-${i}`, `skill-${i}`));
    const { stdout } = run(SETUP, ['--data-source-id', DS, '--from-json', rowsFile(home, rows)], home);

    assert.match(stdout, /setup complete/);
    assert.match(stdout, /skills registered : 60/);
    assert.match(stdout, /transport {9}: mcp \(refresh with \/notion-skills:sync\)/);

    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(config.data_source_id, DS);
    assert.equal(config.transport, 'mcp');
    assert.equal(config.injection, 'session');

    const registry = readFileSync(join(home, 'registry.md'), 'utf8');
    assert.equal(registry.split('\n').filter((l) => l && !l.startsWith('<!--')).length, 60);

    // The whole point of the summary: its size must not scale with the store.
    assert.ok(stdout.length < 600, `summary was ${stdout.length} bytes:\n${stdout}`);
    assert.ok(!stdout.includes('skill-42'), 'the summary must not re-list individual skills');
  });

  test('--json emits a machine-readable summary', () => {
    const home = freshHome();
    const { stdout } = run(
      SETUP,
      ['--data-source-id', DS, '--from-json', rowsFile(home, [row('a', 'one')]), '--json'],
      home,
    );
    const summary = JSON.parse(stdout);
    assert.equal(summary.total, 1);
    assert.equal(summary.effective_transport, 'mcp');
    assert.equal(summary.auto_refresh, false);
    assert.equal(summary.data_source_id, DS);
  });

  test('--dry-run writes nothing', () => {
    const home = freshHome();
    const { stdout } = run(
      SETUP,
      ['--data-source-id', DS, '--from-json', rowsFile(home, [row('a', 'one')]), '--dry-run'],
      home,
    );
    assert.match(stdout, /dry run/);
    assert.equal(existsSync(join(home, 'config.json')), false);
    assert.equal(existsSync(join(home, 'registry.md')), false);
  });

  test('a Japanese schema works via --property, with no renaming in Notion', () => {
    const home = freshHome();
    const rows = [{ id: 'id-1', スキル名: '作業ログ', 発火条件: 'wlog, 作業ログ' }];
    run(
      SETUP,
      [
        '--data-source-id', DS,
        '--from-json', rowsFile(home, rows),
        '--property', 'name=スキル名',
        '--property', 'trigger=発火条件',
      ],
      home,
    );
    assert.match(readFileSync(join(home, 'registry.md'), 'utf8'), /作業ログ \| id1 \| any \| - \| wlog, 作業ログ/);
  });

  test('a wrong title mapping fails loudly and names the real columns', () => {
    const home = freshHome();
    const result = run(
      SETUP,
      ['--data-source-id', DS, '--from-json', rowsFile(home, [{ id: 'a', スキル名: 'x' }])],
      home,
      { expectFailure: true },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no "Name" column/);
    assert.match(result.stderr, /スキル名/);
    assert.match(result.stderr, /--property name=/);
    assert.equal(existsSync(join(home, 'config.json')), false, 'must not write a config it knows is broken');
  });

  test('with no transport and no rows, it says how to get a transport', () => {
    // Nothing can be done here: neither resolution nor fetching is possible.
    const home = freshHome();
    const result = run(SETUP, [`https://notion.so/${DS.replace(/-/g, '')}`], home, { expectFailure: true });
    assert.match(result.stderr, /NOTION_API_TOKEN/);
    assert.match(result.stderr, /notion-skills:sync/);
  });

  test('with rows but no transport, it asks for the data source id it cannot resolve', () => {
    // The rows are in hand, so only the id lookup is impossible — say exactly that
    // rather than repeating the generic "install a transport" advice.
    const home = freshHome();
    const result = run(
      SETUP,
      [`https://notion.so/${DS.replace(/-/g, '')}`, '--from-json', rowsFile(home, [row('a', 'one')])],
      home,
      { expectFailure: true },
    );
    assert.match(result.stderr, /--data-source-id/);
    assert.match(result.stderr, /over MCP/);
  });

  test('a truncated MCP page is refused instead of producing a short registry', () => {
    const home = freshHome();
    const path = rowsFile(home, [row('a', 'one')], { has_more: true });
    const result = run(SETUP, ['--data-source-id', DS, '--from-json', path], home, { expectFailure: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only the first page/);
    assert.equal(existsSync(join(home, 'registry.md')), false);
  });

  test('rejects a --data-source-id that is not a Notion id', () => {
    // On the --from-json path nothing else validates it: the first registry
    // builds fine from the supplied rows, and only the next sync finds out.
    const home = freshHome();
    const result = run(
      SETUP,
      ['--data-source-id', 'not-an-id', '--from-json', rowsFile(home, [row('a', 'one')])],
      home,
      { expectFailure: true },
    );
    assert.match(result.stderr, /not a Notion id/);
    assert.equal(existsSync(join(home, 'config.json')), false, 'must not persist an unusable id');
  });

  test('accepts a data source id given as a dashed uuid, bare hex, or URL', () => {
    for (const given of [DS, DS.replace(/-/g, ''), `https://www.notion.so/ws/Skills-${DS.replace(/-/g, '')}?v=abc`]) {
      const home = freshHome();
      run(SETUP, ['--data-source-id', given, '--from-json', rowsFile(home, [row('a', 'one')])], home);
      assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).data_source_id, DS, given);
    }
  });

  test('a pinned token/ntn transport must be available even when rows are supplied', () => {
    // The pin is what config.json records and what every later sync uses, so
    // accepting it here writes a configuration that cannot work tomorrow.
    for (const [transport, expected] of [
      ['token', /NOTION_API_TOKEN is not set/],
      ['ntn', /not on PATH/],
    ]) {
      const home = freshHome();
      const result = run(
        SETUP,
        ['--data-source-id', DS, '--transport', transport, '--from-json', rowsFile(home, [row('a', 'one')])],
        home,
        { expectFailure: true },
      );
      assert.match(result.stderr, expected, transport);
      assert.equal(existsSync(join(home, 'config.json')), false, `${transport}: must not persist`);
    }
  });

  test('an explicit mcp transport is still fine with rows supplied', () => {
    const home = freshHome();
    run(SETUP, ['--data-source-id', DS, '--transport', 'mcp', '--from-json', rowsFile(home, [row('a', 'one')])], home);
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).transport, 'mcp');
  });

  test('the reported transport matches the one written to config', () => {
    // These disagreed: the summary said mcp while config.json recorded token.
    const home = freshHome();
    const { stdout } = run(
      SETUP,
      ['--data-source-id', DS, '--from-json', rowsFile(home, [row('a', 'one')]), '--json'],
      home,
    );
    const summary = JSON.parse(stdout);
    assert.equal(summary.effective_transport, JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).transport);
  });

  test('prints usage with no arguments and exits 0', () => {
    const home = freshHome();
    const { stdout } = run(SETUP, [], home);
    assert.match(stdout, /Usage:/);
    assert.match(stdout, /--from-json/);
  });
});

describe('sync.mjs --from-json', () => {
  test('refreshes an existing registry over the MCP path', () => {
    const home = freshHome();
    run(SETUP, ['--data-source-id', DS, '--from-json', rowsFile(home, [row('a', 'one')])], home);

    const { stderr } = run(SYNC, ['--from-json', rowsFile(home, [row('a', 'one'), row('b', 'two')])], home);
    assert.match(stderr, /Updated registry: 2 skills/);
    assert.match(readFileSync(join(home, 'registry.md'), 'utf8'), /two \| b/);
  });

  test('--quiet silences the summary but still writes', () => {
    const home = freshHome();
    run(SETUP, ['--data-source-id', DS, '--from-json', rowsFile(home, [row('a', 'one')])], home);
    const { stderr } = run(SYNC, ['--from-json', rowsFile(home, [row('a', 'one')]), '--quiet'], home);
    assert.equal(stderr, '');
  });

  test('fails clearly when the plugin is not configured', () => {
    const home = freshHome();
    const result = run(SYNC, ['--from-json', rowsFile(home, [row('a', 'one')])], home, { expectFailure: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Not configured/);
    assert.match(result.stderr, /notion-skills:setup/);
  });

  test('rejects an unknown flag rather than ignoring it', () => {
    const home = freshHome();
    const result = run(SYNC, ['--frm-json', 'x'], home, { expectFailure: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown argument/);
  });
});

describe('session-start hook', () => {
  const setupHome = () => {
    const home = freshHome();
    run(SETUP, ['--data-source-id', DS, '--from-json', rowsFile(home, [row('a', 'wlog')])], home);
    return home;
  };

  test('injects the registry inside the tagged block', () => {
    const { stdout } = run(HOOK, [], setupHome());
    assert.match(stdout, /^\[notion-skills\]/);
    assert.match(stdout, /<notion-skills-registry>/);
    assert.match(stdout, /wlog \| a \| any \| workflow/);
    assert.match(stdout, /<\/notion-skills-registry>/);
  });

  test('points an unconfigured user at setup, in one line', () => {
    const { stdout } = run(HOOK, [], freshHome());
    assert.match(stdout, /Not configured yet\. Run \/notion-skills:setup/);
    assert.equal(stdout.trim().split('\n').length, 1);
  });

  test('NOTION_SKILLS_DISABLE silences it entirely', () => {
    const { stdout } = run(HOOK, [], setupHome(), { env: { NOTION_SKILLS_DISABLE: '1' } });
    assert.equal(stdout, '');
  });

  test('injection: off silences it entirely', () => {
    const home = setupHome();
    const configPath = join(home, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, injection: 'off' }));
    assert.equal(run(HOOK, [], home).stdout, '');
  });

  test('a stale cache with no script transport asks for a manual sync, and never blocks', () => {
    const home = setupHome();
    const registryPath = join(home, 'registry.md');
    const stale = readFileSync(registryPath, 'utf8').replace(/synced: [^ ]+/, 'synced: 2020-01-01T00:00:00.000Z');
    writeFileSync(registryPath, stale);

    const { stdout, status } = run(HOOK, [], home);
    assert.equal(status, 0);
    assert.match(stdout, /cache may be stale; run \/notion-skills:sync/);
    assert.match(stdout, /<notion-skills-registry>/, 'a stale cache is still better than none');
  });

  test('exits 0 and stays quiet when the registry file is unreadable', () => {
    const home = freshHome();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ data_source_id: DS }));
    const { stdout, status } = run(HOOK, [], home);
    assert.equal(status, 0);
    assert.match(stdout, /Registry not synced yet/);
  });

  test('never fails the session on a corrupt config', () => {
    const home = freshHome();
    writeFileSync(join(home, 'config.json'), '{ this is not json');
    const { status } = run(HOOK, [], home);
    assert.equal(status, 0, 'session start must never be blocked by this hook');
  });
});
