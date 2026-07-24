#!/usr/bin/env node
// Build a standalone router skill for environments without hooks (claude.ai).
//
//   node scripts/build-web-skill.mjs
//
// Hooks only run in Claude Code, so on claude.ai there is no injected registry.
// This produces a self-contained SKILL.md that carries the trigger keywords in
// its own description (so it still fires) and queries Notion over MCP at runtime.
//
// The output goes to the user's state directory — NEVER into this repository —
// because it contains their database id and their skill names.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { queryDataSource } from './notion.mjs';
import { STATE_DIR, dashless, excludedPageIds, loadConfig, plain, selectName } from './lib.mjs';

// claude.ai truncates a skill description at 1024 characters. Anything past the
// cut is silently dropped, so keywords beyond it would never match.
const DESCRIPTION_MAX_CHARS = 1024;
const OUT_DIR = join(STATE_DIR, 'web-skill');

const PREFIX =
  'Routes requests to custom skills stored in the user\'s Notion database. ' +
  'Use when the request matches one of these skills or keywords: ';
const SUFFIX =
  ' Also use for "list my skills" / "スキル一覧" / "使えるスキル". ' +
  'Do not use for general questions that match none of the above.';

function buildDescription(rows, part, total) {
  const prefix = total > 1 ? PREFIX.replace('database.', `database (part ${part}/${total}).`) : PREFIX;
  const budget = DESCRIPTION_MAX_CHARS - prefix.length - SUFFIX.length;

  // Every skill contributes its name first, then keywords fill the remainder,
  // so a long-tail skill never loses its only chance to match.
  const seen = new Set();
  const parts = [];
  let used = 0;
  const add = (text) => {
    const key = text.toLowerCase();
    if (seen.has(key) || used + text.length + 2 > budget) return false;
    seen.add(key);
    parts.push(text);
    used += text.length + 2;
    return true;
  };

  for (const row of rows) add(row.name);
  const dropped = rows.filter((row) => !seen.has(row.name.toLowerCase())).length;

  for (const row of rows) {
    for (const keyword of row.keywords.slice(0, 2)) add(keyword);
  }

  return { text: prefix + parts.join(', ') + '.' + SUFFIX, dropped };
}

/**
 * Split into the fewest chunks whose descriptions all fit the 1024-char budget.
 * Every skill name must appear in some chunk's description, otherwise that skill
 * can never fire on claude.ai.
 */
function splitToFit(rows) {
  for (let count = 1; count <= rows.length; count += 1) {
    const size = Math.ceil(rows.length / count);
    const chunks = [];
    for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
    if (chunks.length !== count) continue;

    const built = chunks.map((chunk, index) => ({
      rows: chunk,
      ...buildDescription(chunk, index + 1, count),
    }));
    if (built.every((chunk) => chunk.dropped === 0)) return built;
  }
  // Unreachable in practice: a single skill always fits on its own.
  return rows.map((row, index) => ({ rows: [row], ...buildDescription([row], index + 1, rows.length) }));
}

function buildRegistryTable(rows) {
  const lines = ['| Skill | Runtime | Page ID | Triggers |', '|---|---|---|---|'];
  for (const row of rows) {
    const triggers = row.trigger.replace(/\|/g, '\\|').slice(0, 100);
    lines.push(`| ${row.name.replace(/\|/g, '\\|')} | ${row.runtime} | ${dashless(row.id)} | ${triggers} |`);
  }
  return lines.join('\n');
}

async function main() {
  const config = loadConfig();
  if (!config?.data_source_id) {
    throw new Error('Not configured. Run /notion-skills:setup first.');
  }

  const map = config.properties;
  const excludedIds = excludedPageIds(config);
  const excludedStatus = config.excluded_status.map((status) => status.toLowerCase());

  const rows = [];
  for (const page of await queryDataSource(config.data_source_id)) {
    if (excludedIds.has(dashless(page.id.toLowerCase()))) continue;

    const name = plain(page.properties?.[map.name]);
    if (!name) continue;

    const status = selectName(page.properties?.[map.status]).toLowerCase();
    if (status && excludedStatus.includes(status)) continue;

    const trigger = plain(page.properties?.[map.trigger]);
    rows.push({
      id: page.id,
      name,
      runtime: selectName(page.properties?.[map.runtime]).toLowerCase() || 'any',
      trigger,
      keywords: trigger
        .split(/[,、]/)
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword && keyword.length <= 24),
    });
  }

  if (rows.length === 0) throw new Error('No skills found — check the database id and property names.');

  rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const chunks = splitToFit(rows);

  mkdirSync(OUT_DIR, { recursive: true });
  process.stderr.write(`${rows.length} skills → ${chunks.length} skill file(s)\n`);

  chunks.forEach((chunk, index) => {
    const suffix = chunks.length > 1 ? `-${index + 1}` : '';
    const dir = join(OUT_DIR, `notion-skill-router${suffix}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), renderSkill(chunk, index + 1, chunks.length, config, rows.length));
    process.stderr.write(
      `  notion-skill-router${suffix}: ${chunk.rows.length} skills / description ${chunk.text.length}/${DESCRIPTION_MAX_CHARS}\n`,
    );
  });

  process.stderr.write(`Wrote ${OUT_DIR}\n`);
  process.stderr.write('  Upload each SKILL.md as a skill in claude.ai (Settings → Capabilities).\n');
}

function renderSkill(chunk, part, total, config, totalSkills) {
  const rows = chunk.rows;
  const scope =
    total > 1
      ? `This build covers ${rows.length} of ${totalSkills} skills (part ${part}/${total}). ` +
        'The other parts are separate skills; if a request matches none of the entries here, one of them may hold it.'
      : `This build covers all ${rows.length} skills.`;

  return `---
name: notion-skill-router${total > 1 ? `-${part}` : ''}
description: >
  ${chunk.text}
---

# Notion Skill Router (web variant)

${scope}

Standalone build for environments without hooks (claude.ai). It carries its own
trigger keywords and queries Notion over the MCP connector at runtime.

**Generated file — do not edit.** Rebuild with \`node scripts/build-web-skill.mjs\`
after adding, renaming, or archiving skills. Skill *page content* needs no rebuild;
it is fetched live.

Database: \`collection://${config.data_source_id}\`

## Use

1. Match the request against the registry below (exact keyword hits first, then
   the skill name). If two match equally well, ask which one.
2. Fetch that page with \`notion-fetch\` using its Page ID.
3. Follow the page content as the skill's full instructions. The page is the
   single source of truth.

If a fetch 404s, this build is stale — re-query the database directly:

\`\`\`
SELECT "Name", "Trigger", "Status", "Category", "Runtime"
FROM "collection://${config.data_source_id}"
\`\`\`

Skip pages whose Status is ${config.excluded_status.join(' / ')}.

\`runtime: claude-code\` skills need a shell, repositories, or MCP servers that
this environment may not have. Fetch and try anyway, but say so if the steps
assume tools that are unavailable here.

For "list my skills", present the table below and link each entry as
\`https://notion.so/<page_id>\` — never show bare page IDs.

## Registry (${rows.length} skills)

${buildRegistryTable(rows)}
`;
}

main().catch((error) => {
  process.stderr.write(`build-web-skill failed: ${error.message}\n`);
  process.exitCode = 1;
});
