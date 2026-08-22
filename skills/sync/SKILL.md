---
name: sync
description: >
  Refresh the local skill registry from the user's Notion skills database.
  Use when the user runs /notion-skills:sync, says their new/renamed Notion skill
  isn't being picked up, or after creating/archiving a skill. Also used by other
  notion-skills skills after they modify the database.
---

# notion-skills: sync

Rebuilds `~/.claude/notion-skills/registry.md` from the database configured in
`~/.claude/notion-skills/config.json`.

`$PLUGIN` below is `${CLAUDE_PLUGIN_ROOT}` when that is set; otherwise it is the
directory two levels up from this SKILL.md.

## With a token or the `ntn` CLI

```bash
node "$PLUGIN/scripts/sync.mjs"
```

The transport comes from `config.json` (`auto` prefers the token, then `ntn`).
The summary and any `warn:` lines go to **stderr** — relay them.

## MCP connector only

A script cannot call an MCP server, so fetch the rows and hand them over. The
script still does the filtering, sorting, truncating and escaping.

1. Read `data_source_id` and `properties` from `~/.claude/notion-skills/config.json`.
2. Query — **`id` is required**, and a registry line without it can never be
   fetched again:
   ```sql
   SELECT id, "Name", "Trigger", "Status", "Category", "Runtime"
   FROM "collection://<data_source_id>"
   ```
   Substitute the user's mapped column names; omit columns the database lacks.
   Take **every** row — if the response says `has_more: true`, page through the
   rest and concatenate them.
3. Write the result to a temp file verbatim, then:
   ```bash
   node "$PLUGIN/scripts/sync.mjs" --from-json <file>
   ```

Do not write `registry.md` by hand. The format has rules that are easy to get
subtly wrong — sort order, `|` escaping, trigger truncation on a comma boundary,
dashless page IDs — and a registry that is merely *short* looks exactly like a
correct one while the missing skills quietly stop routing.

## Report

- The script's summary line (`Updated registry: N skills` or `No changes (N skills)`)
  and every `warn:` line.
- What changed versus the previous cache, if the user cares.
- Already-open sessions keep the old registry; new sessions get the fresh one.
