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

Configures the plugin for this user. Everything user-specific lives in
`~/.claude/notion-skills/` (never inside the plugin directory).

## Step 1: Locate the database

- If `$ARGUMENTS` contains a Notion URL or ID, use it.
- Otherwise ask for the database URL — **or**, if the user has no database yet
  and the Notion MCP connector is available, offer to create one:
  create a database titled "Agent Skills" with properties
  `Name` (title), `Trigger` (rich_text), `Status` (select: active / draft / archived),
  `Category` (select), `Description` (rich_text).

## Step 2: Resolve the data_source_id

A database URL/ID is not yet a data_source_id. Resolve it with whichever
transport is available:

- **Notion MCP**: `notion-fetch` the database; the data source id appears in the
  result (`collection://<data_source_id>`).
- **ntn CLI**: `ntn api v1/databases/<db_id>` → `.data_sources[0].id`
- **REST**: `curl -s -H "Authorization: Bearer $NOTION_API_TOKEN" -H "Notion-Version: 2025-09-03" https://api.notion.com/v1/databases/<db_id>` → `.data_sources[0].id`

If the ID the user gave is already a data_source_id (the databases endpoint 404s
but a data-source query succeeds), use it as-is.

## Step 3: Validate the schema

Query one page (page_size: 1) and inspect the property names. Required:

| logical | default property | type |
|---|---|---|
| name | `Name` | title |
| trigger | `Trigger` | rich_text |

Optional: `Status` (select/status), `Category` (select).

If the database uses different property names (e.g. a Japanese schema), map them
in `properties` below instead of asking the user to rename anything.

## Step 4: Detect the transport

- `NOTION_API_TOKEN` env var set → `token` (background auto-sync works)
- `ntn` CLI installed and logged in (`ntn whoami`) → `ntn` (background auto-sync works)
- Only the Notion MCP connector → `mcp` (user syncs via `/notion-skills:sync`)

Record `"transport": "auto"` unless MCP-only, in which case record `"mcp"`.

## Step 5: Write the config

Write `~/.claude/notion-skills/config.json` (create the directory if needed):

```json
{
  "data_source_id": "<resolved id>",
  "transport": "auto",
  "ttl_hours": 24,
  "injection": "session",
  "properties": { "name": "Name", "trigger": "Trigger", "status": "Status", "category": "Category" },
  "excluded_status": ["archived", "draft", "disabled"]
}
```

Only include `properties` keys that differ from the defaults. Never write a
token into this file.

## Step 6: First sync

Run the sync (see the `sync` skill — script if token/ntn, manual if MCP-only).

## Step 7: Report

- Number of skills registered, listed as a table (name / trigger), each linked
  as `https://notion.so/<page_id>`
- The detected transport, and what that means for freshness:
  - token/ntn: auto-refresh in the background when the cache is older than `ttl_hours`
  - mcp: run `/notion-skills:sync` after changing names/triggers/statuses in Notion
- Remind: page **content** edits apply immediately; only name/trigger/status
  changes need a sync. New sessions pick up the registry automatically.

## Security note (always tell the user once during setup)

Skill page content is executed as instructions. The database should be a
**private database the user controls**. Do not point the router at a shared or
public database where others can edit pages.
