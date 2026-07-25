---
name: web-skill
description: >
  Build the single standalone router skill for environments without hooks (claude.ai).
  Use when the user says the plugin's skills do not fire on claude.ai, asks how to
  use their Notion skills on the web, mentions that no [notion-skills] line appears
  at session start, or runs /notion-skills:web-skill.
---

# notion-skills: web-skill

The SessionStart hook that injects the registry only runs in Claude Code. On
claude.ai there is no injected registry, so the router never fires.

This builds **one** standalone router skill that queries the Notion database live
at runtime. It carries no skill list, so:

- there is no 1024-character description limit to fight (nothing is enumerated),
- it is never split across files,
- it never needs rebuilding when skills are added, renamed, or archived — the
  live query always sees the current set.

## Check first

Confirm the hook really is not running: open a new session and look for a line
starting with `[notion-skills]`. If it is there, the hook works and nothing here
is needed (that environment already has the full registry).

## Build

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-web-skill.mjs"
```

This needs **no** Notion access — it only reads `data_source_id` and the exclude
settings from `~/.claude/notion-skills/config.json`, so it works in every
environment, including MCP-only claude.ai. It writes a single file to
`~/.claude/notion-skills/web-skill/SKILL.md` (outside the plugin, because it
contains the user's database id).

If `node` cannot run at all, produce the same one file by hand: it is a fixed
template with the `data_source_id` and the `excluded_status` / `excluded_pages`
values from config substituted in. There is no skill list to assemble, so there
is nothing to miss.

## Report to the user

- That it produced **one** file, which queries Notion live and never goes stale.
- To upload it as a skill in claude.ai (Settings → Capabilities), **once**.
- To delete any previously uploaded router skill from an earlier approach
  (e.g. `notion-skill-router-1` / `-2`, or `-dev` / `-general`). Those carried a
  frozen skill list; leaving them causes stale, duplicate matching.
- That the Notion connector must be enabled in claude.ai with the skills database
  shared to it — the skill queries the database at runtime.
- That skill **page content** edits, and adding/renaming/archiving skills, all take
  effect with no rebuild. The only reason to rebuild is if the database itself moves.
