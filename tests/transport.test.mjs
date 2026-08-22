import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NOTION_SKILLS_HOME = mkdtempSync(join(tmpdir(), 'notion-skills-transport-'));

const { resolveTransport, detectTransport, hasNtn, TRANSPORTS, SCRIPT_TRANSPORTS } = await import(
  '../scripts/notion.mjs'
);

// A stand-in `ntn` on PATH. hasNtn() only asks whether `ntn --version` runs, so
// a two-line shell script is a faithful stub for "the CLI is installed".
const binDir = mkdtempSync(join(tmpdir(), 'notion-skills-bin-'));
writeFileSync(join(binDir, 'ntn'), '#!/bin/sh\necho "ntn 1.0.0"\n');
chmodSync(join(binDir, 'ntn'), 0o755);

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_TOKEN = process.env.NOTION_API_TOKEN;

const withNtn = () => {
  process.env.PATH = `${binDir}:${ORIGINAL_PATH}`;
};
const withoutNtn = () => {
  // An empty PATH is the cleanest way to guarantee no `ntn` is reachable.
  process.env.PATH = '';
};

beforeEach(() => {
  delete process.env.NOTION_API_TOKEN;
  withoutNtn();
});

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_TOKEN === undefined) delete process.env.NOTION_API_TOKEN;
  else process.env.NOTION_API_TOKEN = ORIGINAL_TOKEN;
});

describe('detectTransport / hasNtn', () => {
  test('token wins when both are available', () => {
    process.env.NOTION_API_TOKEN = 'secret';
    withNtn();
    assert.equal(detectTransport(), 'token');
  });

  test('falls back to ntn when only the CLI is present', () => {
    withNtn();
    assert.equal(hasNtn(), true);
    assert.equal(detectTransport(), 'ntn');
  });

  test('returns null when neither exists (MCP-only)', () => {
    assert.equal(hasNtn(), false);
    assert.equal(detectTransport(), null);
  });
});

describe('resolveTransport: auto', () => {
  test('prefers token, then ntn', () => {
    process.env.NOTION_API_TOKEN = 'secret';
    withNtn();
    assert.equal(resolveTransport('auto').transport, 'token');

    delete process.env.NOTION_API_TOKEN;
    assert.equal(resolveTransport('auto').transport, 'ntn');
  });

  test('defaults to auto when nothing is configured', () => {
    process.env.NOTION_API_TOKEN = 'secret';
    assert.equal(resolveTransport().transport, 'token');
    assert.equal(resolveTransport('').transport, 'token');
    assert.equal(resolveTransport(undefined).transport, 'token');
  });

  test('explains what to do when no transport exists', () => {
    const { transport, reason } = resolveTransport('auto');
    assert.equal(transport, null);
    assert.match(reason, /NOTION_API_TOKEN/);
    assert.match(reason, /ntn/);
    assert.match(reason, /notion-skills:sync/);
  });
});

describe('resolveTransport: explicit choices are honoured, never silently swapped', () => {
  test('"ntn" uses the CLI even when a token is exported', () => {
    // The regression this guards: config.transport used to be ignored entirely,
    // so a user who chose the keychain path silently got the env-var path.
    process.env.NOTION_API_TOKEN = 'secret';
    withNtn();
    assert.equal(resolveTransport('ntn').transport, 'ntn');
  });

  test('"token" does not fall back to ntn', () => {
    withNtn();
    const { transport, reason } = resolveTransport('token');
    assert.equal(transport, null);
    assert.match(reason, /NOTION_API_TOKEN is not set/);
  });

  test('"ntn" does not fall back to the token', () => {
    process.env.NOTION_API_TOKEN = 'secret';
    const { transport, reason } = resolveTransport('ntn');
    assert.equal(transport, null);
    assert.match(reason, /not on PATH/);
    assert.match(reason, /ntn login/);
  });

  test('"mcp" always yields no script transport, whatever else is available', () => {
    process.env.NOTION_API_TOKEN = 'secret';
    withNtn();
    const { transport, reason } = resolveTransport('mcp');
    assert.equal(transport, null);
    assert.match(reason, /cannot call an MCP server/);
    assert.match(reason, /notion-skills:sync/);
  });

  test('is case-insensitive', () => {
    process.env.NOTION_API_TOKEN = 'secret';
    assert.equal(resolveTransport('TOKEN').transport, 'token');
    assert.equal(resolveTransport('MCP').transport, null);
  });

  test('names the valid options for an unknown transport', () => {
    const { transport, reason } = resolveTransport('carrier-pigeon');
    assert.equal(transport, null);
    assert.match(reason, /Unknown transport "carrier-pigeon"/);
    for (const name of TRANSPORTS) assert.ok(reason.includes(name), `reason should list ${name}`);
  });
});

describe('exported transport sets', () => {
  test('mcp is a transport but not a script transport', () => {
    assert.deepEqual(SCRIPT_TRANSPORTS, ['token', 'ntn']);
    assert.deepEqual(TRANSPORTS, ['token', 'ntn', 'mcp']);
  });
});
