---
name: web-skill
description: >
  Build a standalone router skill for environments without hooks (claude.ai).
  Use when the user says the plugin's skills do not fire on claude.ai, asks how to
  use their Notion skills on the web, mentions that no [notion-skills] line appears
  at session start, or runs /notion-skills:web-skill.
---

# notion-skills: web-skill

The SessionStart hook that injects the registry only runs in Claude Code. On
claude.ai there is no injected registry, so the router has no trigger keywords in
its description and will not fire for individual skills.

This builds a standalone skill that carries those keywords itself and queries
Notion over the MCP connector at runtime.

## Check first

Before building, confirm the hook really is not running: open a new session and
look for a line starting with `[notion-skills]`. If it is there, the hook works
and nothing here is needed.

## Build

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-web-skill.mjs"
```

Requires `NOTION_API_TOKEN` or the `ntn` CLI (the same transports as `sync`).
In an MCP-only setup this script cannot run — see "MCP-only" below.

Output goes to `~/.claude/notion-skills/web-skill/`, one directory per generated
skill. It is written outside the plugin because it contains the user's database
id and skill names.

## Report to the user

- How many skills and how many files were produced, and why it split if it did
  (claude.ai truncates a description at 1024 characters and silently drops the
  rest, so every skill name has to fit in some description)
- That each `SKILL.md` must be uploaded as a skill in claude.ai
- That the Notion connector must be enabled there, with the skills database shared to it
- That a rebuild is needed after adding, renaming, or archiving skills — but not
  after editing a skill's page content, which is fetched live

## MCP-only

Without a script transport, generate the same thing yourself: query the database,
then write the files following the structure the script produces — a description
listing every skill name (split across files to stay under 1024 characters each)
and a registry table of name / runtime / page id / triggers.
