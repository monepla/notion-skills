// Matching a prompt against the registry (scripts/lib.mjs) and the hook that
// attaches the result to that prompt (hooks/user-prompt-submit.mjs).
//
// The case behind this: a user typed "update modules", the matching skill had
// not reached the model's context (the session-start registry arrived as a
// preview), and the model called the Skill tool with the skill's name. That
// fails — a Notion skill is a page, not an installed skill.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// STATE_DIR is resolved when lib.mjs is first imported.
process.env.NOTION_SKILLS_HOME = mkdtempSync(join(tmpdir(), 'notion-skills-match-'));

const lib = await import('../scripts/lib.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, 'hooks', 'user-prompt-submit.mjs');
const SESSION_HOOK = join(ROOT, 'hooks', 'session-start.mjs');
const NOT_A_SKILL_TOOL_NAME = 'never pass them to the Skill tool';

// Placeholder ids only — tests/shipped-docs.test.mjs refuses real-looking ones.
const ID_SUBMODULES = '0123456789abcdef0123456789abcdef';
const ID_WLOG = '11111111222233334444555555555555';
const ID_SEO = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const ID_REVIEW = '00000000111122223333444444444444';

const ROWS = [
  {
    id: ID_SUBMODULES,
    name: 'update-submodules',
    runtime: 'claude-code',
    category: 'workflow',
    trigger: 'サブモジュール更新, サブモジュール最新化, update submodules',
  },
  { id: ID_WLOG, name: 'wlog', runtime: 'claude-code', category: 'workflow', trigger: '作業ログ, wlog, Notionにログ' },
  { id: ID_SEO, name: 'seo', runtime: 'any', category: 'document', trigger: 'SEO, 検索順位, REST API, sitemap …' },
  { id: ID_REVIEW, name: 'security-review', runtime: 'claude-code', category: 'review', trigger: 'セキュリティレビュー, 認証' },
];

const REGISTRY = lib.renderRegistry(ROWS, 'ds-1', '2026-09-13T00:00:00.000Z');
const REGISTRY_ROWS = lib.parseRegistry(REGISTRY);
const names = (prompt) => lib.matchSkills(prompt, REGISTRY_ROWS).map((match) => match.row.name);

describe('parseRegistry', () => {
  test('reads back what renderRegistry wrote', () => {
    assert.deepEqual(REGISTRY_ROWS, ROWS);
  });

  test('keeps a literal pipe inside a field', () => {
    const text = lib.renderRegistry([{ ...ROWS[1], trigger: 'a | b' }], 'ds', new Date().toISOString());
    assert.equal(lib.parseRegistry(text)[0].trigger, 'a | b');
  });

  test('skips comments, blank lines and lines without a page id', () => {
    const text = '<!-- header -->\n\nnot a registry line\nname | not-an-id | any | - | trigger\n';
    assert.deepEqual(lib.parseRegistry(text), []);
    assert.deepEqual(lib.parseRegistry(undefined), []);
  });
});

describe('matchSkills', () => {
  test('the observed prompt: "update modules" finds update-submodules', () => {
    // The skill name was never typed — only "update modules", between Japanese.
    const prompt = 'pullしてから\nupdate modules\n対応して\n親リポジトリのmainブランチ更新して';
    assert.deepEqual(names(prompt), ['update-submodules']);
  });

  test('an exact name anywhere in the prompt', () => {
    assert.deepEqual(names('wlog を残して'), ['wlog']);
  });

  test('a Japanese keyword typed with particles in between', () => {
    assert.deepEqual(names('サブモジュールを更新して'), ['update-submodules']);
  });

  test('short Latin keywords and names match only as whole words', () => {
    assert.deepEqual(names('a trip to seoul'), []);
    assert.deepEqual(names('SEO を見直して'), ['seo']);
    assert.deepEqual(names('ＳＥＯ改善'), ['seo'], 'full-width letters fold to the same word');
  });

  test('a keyword cut short by sync still matches on what is left', () => {
    assert.deepEqual(names('update the sitemap'), ['seo']);
  });

  test('does not assemble a match from fragments of unrelated words', () => {
    assert.deepEqual(names('an interest in rapid prototyping'), [], '"REST API" must not come from inte-rest / rap-id');
    assert.deepEqual(names('update the README'), [], 'one word of a two-word name is not enough');
    assert.deepEqual(names('ログを見て'), [], 'a mixed-script keyword does not get the particle rule');
  });

  test('a name hit ranks above a keyword-only hit', () => {
    assert.deepEqual(names('wlog と サブモジュール更新'), ['wlog', 'update-submodules']);
  });

  test('returns at most the limit', () => {
    const prompt = 'wlog seo update-submodules security-review';
    assert.equal(lib.matchSkills(prompt, REGISTRY_ROWS, { limit: 2 }).length, 2);
    assert.equal(lib.matchSkills(prompt, REGISTRY_ROWS).length, 3);
  });

  test('empty prompts and missing rows return nothing instead of throwing', () => {
    assert.deepEqual(lib.matchSkills('', REGISTRY_ROWS), []);
    assert.deepEqual(lib.matchSkills('   ', REGISTRY_ROWS), []);
    assert.deepEqual(lib.matchSkills('wlog', []), []);
    assert.deepEqual(lib.matchSkills('wlog', undefined), []);
  });
});

describe('renderPromptMatches', () => {
  test('carries the page id and says the names are not Skill tool names', () => {
    const text = lib.renderPromptMatches(lib.matchSkills('update modules', REGISTRY_ROWS));
    assert.match(text, /^\[notion-skills\]/);
    assert.ok(text.includes(`update-submodules — page_id ${ID_SUBMODULES}`), text);
    assert.ok(text.includes('notion-fetch'), text);
    assert.ok(text.includes(NOT_A_SKILL_TOOL_NAME), text);
  });
});

describe('user-prompt-submit hook', () => {
  const home = (config = {}, registry = REGISTRY) => {
    const dir = mkdtempSync(join(tmpdir(), 'notion-skills-prompt-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ data_source_id: 'ds-1', transport: 'mcp', ...config }));
    if (registry !== null) writeFileSync(join(dir, 'registry.md'), registry);
    return dir;
  };

  const payload = (prompt) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt });

  function runHook(dir, input, env = {}) {
    const child = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      input,
      env: { PATH: '', NOTION_SKILLS_HOME: dir, ...env },
    });
    if (child.error) assert.fail(`hook failed to start: ${child.error.message}`);
    return { stdout: child.stdout ?? '', stderr: child.stderr ?? '', status: child.status };
  }

  test('attaches the matching skill and its page id as additionalContext', () => {
    const { stdout, status } = runHook(home(), payload('update modules してから main 更新して'));
    assert.equal(status, 0);
    const output = JSON.parse(stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const context = output.hookSpecificOutput.additionalContext;
    assert.ok(context.includes(`update-submodules — page_id ${ID_SUBMODULES}`), context);
    assert.ok(context.includes(NOT_A_SKILL_TOOL_NAME), context);
  });

  test('stays silent when nothing matches', () => {
    const { stdout, status } = runHook(home(), payload('what time is it'));
    assert.equal(status, 0);
    assert.equal(stdout, '');
  });

  test('stays silent for a slash command — the user already chose what to run', () => {
    assert.equal(runHook(home(), payload('/update-submodules')).stdout, '');
  });

  test('prompt_match: off, injection: off and NOTION_SKILLS_DISABLE each silence it', () => {
    const prompt = payload('update modules');
    assert.equal(runHook(home({ prompt_match: 'off' }), prompt).stdout, '');
    assert.equal(runHook(home({ injection: 'off' }), prompt).stdout, '');
    assert.equal(runHook(home(), prompt, { NOTION_SKILLS_DISABLE: '1' }).stdout, '');
    // The pair: the same prompt does produce a note when nothing turns it off.
    assert.notEqual(runHook(home(), prompt).stdout, '');
  });

  test('never fails a prompt on bad state or bad input', () => {
    const unconfigured = mkdtempSync(join(tmpdir(), 'notion-skills-prompt-'));
    const corrupt = home();
    writeFileSync(join(corrupt, 'config.json'), '{ this is not json');

    for (const [label, dir, input] of [
      ['not configured', unconfigured, payload('update modules')],
      ['corrupt config', corrupt, payload('update modules')],
      ['no registry yet', home({}, null), payload('update modules')],
      ['stdin is not JSON', home(), 'not json'],
      ['prompt is not a string', home(), JSON.stringify({ prompt: 42 })],
      ['no stdin at all', home(), ''],
    ]) {
      const { stdout, status } = runHook(dir, input);
      assert.equal(status, 0, `${label}: a prompt must never be blocked by this hook`);
      assert.equal(stdout, '', label);
    }
  });

  test('the note stays small however large the registry is', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      id: ID_WLOG,
      name: `skill-${i}`,
      runtime: 'any',
      category: '-',
      trigger: '作業ログ',
    }));
    const big = lib.renderRegistry(many, 'ds-1', '2026-09-13T00:00:00.000Z');
    const { stdout } = runHook(home({}, big), payload('作業ログを残して'));
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.equal(context.split('\n').filter((line) => line.startsWith('- ')).length, 3);
    assert.ok(context.length < 1500, `note was ${context.length} chars`);
  });
});

describe('shipped wiring', () => {
  test('hooks.json registers the prompt hook, pointing at a script that ships', () => {
    // A hook script that is not registered never runs.
    const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
    const commands = (hooks.UserPromptSubmit ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));
    assert.ok(
      commands.some((command) => command.includes('${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.mjs')),
      JSON.stringify(commands),
    );
    assert.ok(statSync(HOOK).isFile());
  });

  test('every place that lists skill names says they are not Skill tool names', () => {
    // Fix the class: the session-start block, the router, and the web variant all
    // put skill names in front of the model.
    const sessionHome = mkdtempSync(join(tmpdir(), 'notion-skills-prompt-'));
    writeFileSync(join(sessionHome, 'config.json'), JSON.stringify({ data_source_id: 'ds-1', transport: 'mcp' }));
    writeFileSync(join(sessionHome, 'registry.md'), REGISTRY);
    const session = spawnSync(process.execPath, [SESSION_HOOK], {
      encoding: 'utf8',
      env: { PATH: '', NOTION_SKILLS_HOME: sessionHome },
    });
    assert.ok(session.stdout.includes(NOT_A_SKILL_TOOL_NAME), session.stdout);

    const router = readFileSync(join(ROOT, 'skills', 'notion-skill-router', 'SKILL.md'), 'utf8');
    assert.match(router, /never\s+pass one to the Skill tool/);
    assert.ok(router.includes('~/.claude/notion-skills/registry.md'), 'router must say where to look past a cut-short block');

    const web = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-web-skill.mjs')], {
      encoding: 'utf8',
      env: { PATH: '', NOTION_SKILLS_HOME: sessionHome },
    });
    assert.equal(web.status, 0, web.stderr);
    const webSkill = readFileSync(join(sessionHome, 'web-skill', 'SKILL.md'), 'utf8');
    assert.match(webSkill, /never pass one to the Skill tool/);
  });
});
