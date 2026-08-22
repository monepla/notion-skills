---
name: setup
description: >
  Set up the notion-skills plugin: point it at the user's Notion skills database,
  validate the schema, write config, and run the first sync. Use when the user runs
  /notion-skills:setup, pastes a Notion database URL asking to use it as a skill store,
  or asks to configure / reconfigure / initialize notion-skills.
argument-hint: "[Notion database URL or ID]"
---

# notion-skills: setup

`scripts/setup.mjs` does the whole job in one process — resolve the data source,
check the schema, write the config, run the first sync. Run it and report what it
says. Do **not** re-implement those steps as separate tool calls: each one is a
round trip, and the script is deterministic.

Everything user-specific lands in `~/.claude/notion-skills/`, never inside the
plugin directory. No token is ever written to disk.

`$PLUGIN` below is `${CLAUDE_PLUGIN_ROOT}` when that is set; otherwise it is the
directory two levels up from this SKILL.md.

## Step 1: Get the database

- If `$ARGUMENTS` holds a Notion URL or ID, use it.
- Otherwise ask for the database URL — **or**, if the user has no database yet
  and the Notion MCP connector is available, offer to create one:
  a database titled "Agent Skills" with properties
  `Name` (title), `Trigger` (rich_text), `Status` (select: active / draft / archived),
  `Category` (select), `Runtime` (select: any / claude-code / notion),
  `Description` (rich_text).

## Step 2: Run setup

**With `NOTION_API_TOKEN` set, or the `ntn` CLI installed** — one command:

```bash
node "$PLUGIN/scripts/setup.mjs" "<database URL or id>"
```

**MCP connector only** — the script cannot call an MCP server, so fetch the rows
yourself and hand them over. Three calls, no hand-written registry:

1. `notion-fetch` the database URL. Read the data source id out of the
   `collection://<data_source_id>` tag in the result.
2. `notion-query-data-sources` — **`id` is required**; without it the rows cannot
   be turned into a registry:
   ```sql
   SELECT id, "Name", "Trigger", "Status", "Category", "Runtime"
   FROM "collection://<data_source_id>"
   ```
   Use the user's own column names if they differ. Omit columns the database
   lacks. Take **every** row: if the response says `has_more: true`, page through
   the rest and concatenate — a partial registry silently stops routing whatever
   is missing.
3. Write the result to a temp file verbatim and run:
   ```bash
   node "$PLUGIN/scripts/setup.mjs" --data-source-id <id> --from-json <file>
   ```

Write the rows out as they came back. The script does the filtering, sorting,
truncation and escaping — transcribing the registry format by hand is how skills
get dropped.

## Step 3: Handle what the script reports

It exits non-zero with the reason. The ones worth knowing:

| Message | Do this |
|---|---|
| `no "Name" column (its columns: …)` | Re-run adding `--property name=<their title column>` (repeatable: `trigger`, `status`, `category`, `runtime`) |
| `Every one of the N row(s) was filtered out` | Their `Status` values collide with `excluded_status`; ask which statuses mean "live" |
| `carry no page id` | The MCP `SELECT` omitted `id` — re-query with it |
| `only the first page ("has_more": true)` | Fetch the remaining pages and re-run |
| `Cannot reach Notion` | No transport: use the MCP path above |

Other flags: `--transport`, `--injection session|off`, `--ttl-hours`,
`--exclude-page <id or URL>` (repeatable), `--dry-run`, `--json`.
Re-running is safe — it merges over the existing config.

## Step 4: Report

Relay the script's summary — skill count, transport, categories. **Do not list
every skill**; on a 66-skill store the summary is ~340 bytes and the registry is
~9 KB, and re-emitting it as a linked table costs the user a slow turn for
information they can already see in Notion. If they ask for the list, then show
it (linked as `https://notion.so/<page_id>`, never bare IDs).

Add:

- What freshness means for them: `token`/`ntn` refresh in the background once the
  cache passes `ttl_hours`; `mcp` needs `/notion-skills:sync`.
- Page **content** edits apply immediately. Only name/trigger/status changes, and
  added or archived skills, need a sync.
- New sessions pick up the registry automatically — this one will not have it.
- Any `warn:` / `note:` lines the script printed.
- If the Notion MCP connector is available, that the same database also works as
  a skill store for Notion AI — see "Use the same skills from Notion AI" in the
  plugin README.

## Security note (say this once, during setup)

Skill page content is executed as instructions. The database should be a
**private database the user controls**. Anyone who can edit those pages can put
instructions into their sessions, so do not point the router at a shared or
public database.
