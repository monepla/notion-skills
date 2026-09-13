#!/usr/bin/env node
// UserPromptSubmit hook: when a prompt matches skills in the synced registry,
// attach a short note naming them with their page ids — to that prompt only.
//
// Why this exists:
//   The session-start registry is one block for the whole session, and a large
//   one reaches the model only as a preview (Claude Code keeps oversized hook
//   output in a file and shows its start). A skill past that point is visible,
//   at best, as a bare name in some other listing — and a bare name gets guessed
//   into a Skill tool call, which fails: the skill is a Notion page, not an
//   installed skill. Observed: "update modules" became Skill("update-submodules")
//   and came back "Unknown skill".
//
//   This hook matches against the registry FILE, not whatever reached the
//   context, and hands over the page id before the model has picked a tool.
//
// Privacy: the prompt is read on this machine, compared with registry.md, and
// dropped. Nothing is stored and nothing is sent anywhere.
//
// Behavior:
//   - not configured / injection: 'off' / prompt_match: 'off' /
//     NOTION_SKILLS_DISABLE                  → nothing
//   - a slash command                        → nothing (the user chose what to run)
//   - no match                               → nothing
//   - matches                                → additionalContext, at most three skills
//
// This hook must NEVER block or break a prompt: no network, all errors
// swallowed, always exit 0.

import { readFileSync } from 'node:fs';

import { REGISTRY_PATH, loadConfig, matchSkills, parseRegistry, renderPromptMatches } from '../scripts/lib.mjs';

function main() {
  if (process.env.NOTION_SKILLS_DISABLE) return;

  const config = loadConfig();
  if (!config?.data_source_id) return;
  if (config.injection === 'off' || config.prompt_match === 'off') return;

  const input = JSON.parse(readFileSync(0, 'utf8'));
  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  if (!prompt.trim() || /^\s*\//.test(prompt)) return;

  const matches = matchSkills(prompt, parseRegistry(readFileSync(REGISTRY_PATH, 'utf8')));
  if (matches.length === 0) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: renderPromptMatches(matches) },
    })}\n`,
  );
}

try {
  main();
} catch {
  // Never break a prompt.
}
