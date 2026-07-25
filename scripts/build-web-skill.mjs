#!/usr/bin/env node
// Build a single standalone router skill for environments without hooks (claude.ai).
//
//   node scripts/build-web-skill.mjs
//
// Hooks only run in Claude Code, so on claude.ai there is no injected registry.
// The web variant does NOT enumerate skills — it carries only the database id and
// queries Notion over MCP at runtime, so it always sees the full, current skill
// set. That means:
//   - no 1024-char description limit to fight (nothing is listed),
//   - no splitting into multiple files,
//   - no regeneration when skills are added / renamed / archived.
//
// It needs no Notion access to build (only the data_source_id from config), so it
// works in every environment — including MCP-only claude.ai — with no manual path.
//
// Output goes to the user's state directory, never into this repo: it contains
// the user's database id.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STATE_DIR, loadConfig } from './lib.mjs';

const OUT_PATH = join(STATE_DIR, 'web-skill', 'SKILL.md');

function render(config) {
  const ds = config.data_source_id;
  const excluded = config.excluded_status.join(', ');
  const excludedPages = (config.excluded_pages ?? []).length
    ? config.excluded_pages.join(', ')
    : '(none)';
  const props = config.properties;

  return `---
name: notion-skill-router
description: >
  Routes a request to one of the user's custom skills stored in their Notion
  database. Use whenever the user asks to do something that could be one of their
  saved skills, names a skill, or asks "what skills do I have", "list my skills",
  "スキル一覧", "使えるスキル". When unsure whether a request matches a saved skill,
  check the database (below) rather than answering from general knowledge.
  Do not use for general questions clearly unrelated to the user's saved skills.
---

# Notion Skill Router (web variant)

Standalone router for environments without the SessionStart hook (claude.ai).
It holds no skill list — it queries the database live every time, so it always
sees the full, current set. Nothing here goes stale when skills change; only edit
this file if the database itself moves.

Skills database: \`collection://${ds}\`

## Step 1: Load the current skills

Query the database over the Notion MCP connector and **page through every result**
(do not stop at the first batch):

\`\`\`
SELECT "${props.name}", "${props.trigger}", "${props.status}", "${props.category}", "${props.runtime}"
FROM "collection://${ds}"
\`\`\`

Exclude a page if:
- its ${props.status} is one of: ${excluded}, or
- its id is one of these excluded pages: ${excludedPages}

The rest are the user's active skills. Because this runs at request time, a skill
added or renamed in Notion is picked up immediately — no rebuild.

## Step 2: Match

Compare the request against skill names and their ${props.trigger} keywords.
Prefer exact keyword hits, then fall back to semantic similarity with the name.
If two match equally well, ask which one — a single short question listing only
the candidates.

For "list my skills" style requests, present all active skills as a table
(name / category / trigger) and link each as \`https://notion.so/<page_id>\`
(the id with dashes removed). Never show bare page IDs.

## Step 3: Fetch and execute

Fetch the matched page with \`notion-fetch\` (its id from the query) and follow its
content as the skill's full instructions. The page is the single source of truth —
do not add guesses beyond what it says.

A skill whose ${props.runtime} is \`claude-code\` was written for tools (a shell,
repositories, MCP servers) that claude.ai may not have. Fetch and try anyway, but
tell the user if its steps assume tools unavailable here.

## Efficiency

Only query when a request plausibly matches a saved skill or asks for the list.
Do not query on unrelated turns. Within a session you may reuse the result of an
earlier query in the same session rather than re-fetching every turn.
`;
}

function main() {
  const config = loadConfig();
  if (!config?.data_source_id) {
    throw new Error('Not configured. Run /notion-skills:setup first.');
  }

  mkdirSync(join(STATE_DIR, 'web-skill'), { recursive: true });
  writeFileSync(OUT_PATH, render(config));

  process.stderr.write(`Wrote ${OUT_PATH}\n`);
  process.stderr.write('  One file, no skill list — queries Notion live, so it never goes stale.\n');
  process.stderr.write('  Upload it once as a skill in claude.ai (Settings → Capabilities).\n');
}

main();
