---
name: sync
description: >
  Refresh the local skill registry from the user's Notion skills database.
  Use when the user runs /notion-skills:sync, says their new/renamed Notion skill
  isn't being picked up, or after creating/archiving a skill. Also used by other
  notion-skills skills after they modify the database.
---

# notion-skills: sync

Rebuilds `~/.claude/notion-skills/registry.md` from the Notion database
configured in `~/.claude/notion-skills/config.json`.

## Preferred path: the sync script

If `NOTION_API_TOKEN` is set or the `ntn` CLI is available, just run:

```bash
node "$(dirname of this plugin)/scripts/sync.mjs"
```

(The plugin root is where this SKILL.md lives — `../../scripts/sync.mjs` relative
to it.) Report the script's summary line and any `warn:` lines to the user.

## Fallback path: MCP-only environments

When neither token nor `ntn` exists but the Notion MCP connector does, perform
the sync yourself:

1. Read `config.json` for `data_source_id`, `properties`, `excluded_status`.
2. Query all pages: `notion-query-data-sources` with
   `SELECT "Name", "Trigger", "Status", "Category", "Runtime" FROM "collection://<data_source_id>"`
   (substitute mapped property names; omit columns the database doesn't have).
   Fetch all pages, not just the first batch.
3. Filter out pages whose status is in `excluded_status` (case-insensitive).
   Keep pages with no status.
4. Build the registry and WRITE it to `~/.claude/notion-skills/registry.md`
   with this exact format — the SessionStart hook parses the header:

```
<!-- notion-skills registry | synced: <ISO8601 UTC now> | count: <N> | source: <data_source_id> -->
<!-- format: name | page_id (dashless) | runtime | category | trigger keywords -->
<name> | <page_id without dashes> | <runtime, default any> | <category or -> | <trigger keywords, ≤100 chars>
...
```

   - One line per skill, sorted by category then name.
   - Escape literal `|` in fields as `\|`.
   - Truncate trigger text at ~100 chars on a comma boundary, appending ` …`.

5. Warn the user about: pages with empty names (skipped), duplicate skill
   names, skills with no trigger keywords.

## Report

- Skill count and what changed (added / removed / renamed vs the previous cache
  if it existed)
- Note that already-open sessions keep the old registry; new sessions get the
  fresh one automatically.
