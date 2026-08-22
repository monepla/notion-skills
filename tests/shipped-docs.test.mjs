// Guards on the shipped instruction text.
//
// The skills are prose, but parts of them are load-bearing: the model follows
// them literally. These check the properties that broke in practice, across
// EVERY file that ships them — the original defect (an MCP SELECT with no `id`)
// existed in three places at once, and fixing only the reported one would have
// left the claude.ai path still unable to fetch a single page.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.NOTION_SKILLS_HOME = mkdtempSync(join(tmpdir(), 'notion-skills-docs-'));

/** Text files in the repository, optionally skipping some directories. */
function textFiles({ skip = [] } = {}, dir = ROOT, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name) || skip.includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) textFiles({ skip }, path, acc);
    else if (/\.(md|mjs|js|json|ya?ml)$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

/** Files that carry instruction text the model follows, or that generate it. */
const instructionFiles = () => textFiles({ skip: ['tests'] });

/**
 * Everything in the repository. Installing from a git source clones the whole
 * tree onto the user's disk, so fixtures ship too — a secret in a test file is
 * just as published as one in a skill.
 */
const allFiles = () => textFiles();

/** Every `SELECT … FROM "collection://…"` in the shipped payload. */
function collectionSelects() {
  const found = [];
  for (const path of instructionFiles()) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/SELECT\s+([\s\S]*?)\s+FROM\s+["'`]?\$?\{?collection:/gi)) {
      found.push({ file: relative(ROOT, path), columns: match[1] });
    }
  }
  return found;
}

describe('MCP queries against the skills database', () => {
  test('at least one exists (the guard would be vacuous otherwise)', () => {
    assert.ok(collectionSelects().length >= 3, 'expected the router, sync and web-skill queries');
  });

  test('every one selects `id`', () => {
    // Without id the rows cannot be turned into a registry, the page cannot be
    // fetched, and the skill list cannot be linked.
    for (const { file, columns } of collectionSelects()) {
      assert.match(columns, /(^|[\s,(])id([\s,)]|$)/, `${file}: SELECT ${columns} — missing id`);
    }
  });
});

describe('generated web skill', () => {
  const build = async (config) => {
    const home = mkdtempSync(join(tmpdir(), 'notion-skills-web-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-web-skill.mjs')], {
      encoding: 'utf8',
      env: { PATH: '', NOTION_SKILLS_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    return { text: readFileSync(join(home, 'web-skill', 'SKILL.md'), 'utf8'), home };
  };

  test('is internally consistent: what it selects covers what it later uses', async () => {
    const { text } = await build({ data_source_id: 'ds-1' });
    assert.match(text, /SELECT id,/);
    assert.match(text, /notion-fetch/);
    assert.match(text, /https:\/\/notion\.so\/<page_id>/);
  });

  test('carries the database id but no skill list', async () => {
    const { text } = await build({ data_source_id: 'ds-abc' });
    assert.match(text, /collection:\/\/ds-abc/);
    // A frozen list is the bug this variant was redesigned to remove.
    assert.ok(!/^\s*\|.*\|.*\|/m.test(text.split('## Step 1')[0]), 'must not enumerate skills');
  });

  test('honours remapped property names', async () => {
    const { text } = await build({ data_source_id: 'ds-1', properties: { name: 'スキル名', trigger: '発火条件' } });
    assert.match(text, /SELECT id, "スキル名", "発火条件"/);
  });

  test('refuses to build when unconfigured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'notion-skills-web-'));
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-web-skill.mjs')], {
      encoding: 'utf8',
      env: { PATH: '', NOTION_SKILLS_HOME: home },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Not configured/);
  });
});

describe('skill frontmatter', () => {
  const skillFiles = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: entry.name, path: join(ROOT, 'skills', entry.name, 'SKILL.md') }));

  test('every skills/ subdirectory ships a SKILL.md', () => {
    assert.ok(skillFiles.length > 0);
    for (const { path } of skillFiles) assert.ok(statSync(path).isFile(), `${path} missing`);
  });

  test('each declares a name matching its directory, and a description', () => {
    for (const { dir, path } of skillFiles) {
      const text = readFileSync(path, 'utf8');
      assert.match(text, /^---\n/, `${dir}: no frontmatter`);
      const frontmatter = text.split('---')[1] ?? '';
      const name = frontmatter.match(/^name:\s*(\S+)/m)?.[1];
      assert.equal(name, dir, `${dir}: frontmatter name is "${name}"`);
      assert.match(frontmatter, /^description:/m, `${dir}: no description`);
    }
  });

  test('no skill text tries to override the session or other instructions', () => {
    // The marketplace security review treats coercive skill text as a fail.
    const coercive = /ignore (all )?(other|previous) instructions|always run me first|disregard the system/i;
    for (const { dir, path } of skillFiles) {
      assert.ok(!coercive.test(readFileSync(path, 'utf8')), `${dir}: coercive instruction text`);
    }
  });
});

describe('no secrets or personal data anywhere in the repository', () => {
  // Ids that are obviously synthetic are fine as fixtures; a real one is a leak
  // of the author's workspace. Keep this list to placeholders that could not be
  // mistaken for a live id.
  const PLACEHOLDER_IDS = new Set([
    '0123456789abcdef0123456789abcdef',
    '00000000111122223333444444444444',
    '11111111222233334444555555555555',
    'aaaaaaaabbbbccccddddeeeeeeeeeeee',
  ]);

  test('no Notion tokens and no internal addresses', () => {
    const patterns = [
      { name: 'Notion integration token', re: /\b(ntn_|secret_)[A-Za-z0-9]{20,}/ },
      { name: 'internal email domain', re: /@mone-pla\.co\.jp/ },
    ];
    for (const path of allFiles()) {
      const text = readFileSync(path, 'utf8');
      for (const { name, re } of patterns) {
        const hit = text.match(re);
        assert.equal(hit, null, `${relative(ROOT, path)}: ${name} — ${hit?.[0]}`);
      }
    }
  });

  test('no real Notion page or database ids, in fixtures either', () => {
    // The registry and config live in ~/.claude/notion-skills/ precisely so that
    // page ids never reach this repository. Installing clones the whole tree, so
    // a test fixture is published exactly as much as a skill is.
    for (const path of allFiles()) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/(?<![0-9a-fA-F-])([0-9a-f]{32})(?![0-9a-fA-F-])/g)) {
        assert.ok(
          PLACEHOLDER_IDS.has(match[1]),
          `${relative(ROOT, path)}: real-looking Notion id ${match[1]} — use a placeholder`,
        );
      }
      for (const match of text.matchAll(
        /(?<![0-9a-fA-F])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-fA-F])/g,
      )) {
        assert.ok(
          PLACEHOLDER_IDS.has(match[1].replace(/-/g, '')),
          `${relative(ROOT, path)}: real-looking Notion id ${match[1]} — use a placeholder`,
        );
      }
    }
  });
});
