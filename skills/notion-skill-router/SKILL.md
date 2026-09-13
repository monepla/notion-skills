---
name: notion-skill-router
description: >
  Routes requests to custom skills the user keeps in their own Notion database.
  Use when the user's request matches a skill name or trigger keyword listed in the
  <notion-skills-registry> block injected into context at session start, or when the
  user asks "what skills do I have", "list my skills", "スキル一覧", "使えるスキル".
  Also use when the user explicitly names one of their registered Notion skills.
  Do not use for general questions that match nothing in the registry.
---

# Notion Skill Router

The user stores custom skills as pages in a Notion database. Each page's
content is the skill's full instruction set (the equivalent of a SKILL.md).
This router matches a request to a registry entry, fetches the page, and
executes it.

## Registry

The registry is injected at session start inside `<notion-skills-registry>` tags.
Line format:

```
name | page_id (32 hex chars, dashless) | runtime | category | trigger keywords
```

`runtime` declares where the skill can execute: `any` (portable), `claude-code`
(needs local tools — shell, repos, MCP servers), `notion` (written for Notion AI /
Notion Agents). In a Claude Code session, `any` and `claude-code` run normally;
for a `notion` skill, still fetch and try, but tell the user it was written for
Notion AI if its steps assume Notion-Agent-only capabilities.

If there is no registry block in context, fall back to querying Notion directly
(see "Fallback: no registry in context" below).

## Step 1: Match

A prompt that matches the registry arrives with a `[notion-skills]` note listing
the matching skills and their page ids. When that note is there, start from it.

Registry names are Notion pages, not Skill tool names or slash commands — never
pass one to the Skill tool.

Compare the user's request against skill names and trigger keywords.
Prefer exact keyword hits; fall back to semantic similarity with the skill name.
If two or more skills match equally well, ask the user which one they mean —
one short question listing only the matching candidates.

The registry block can reach you cut short: a large one arrives as a preview.
If the skill you need is not in the part you can see, look it up in
`~/.claude/notion-skills/registry.md` before concluding it does not exist.

## Step 2: Fetch the skill page

Use whichever works in this environment (try in this order):

1. **Notion MCP connector**: `notion-fetch` with the page ID.
2. **ntn CLI**: `ntn api v1/blocks/<page_id>/children`
3. **NOTION_API_TOKEN**: `curl -s -H "Authorization: Bearer $NOTION_API_TOKEN" -H "Notion-Version: 2025-09-03" https://api.notion.com/v1/blocks/<page_id>/children`

If the fetch 404s, the registry is stale: run `/notion-skills:sync`, then retell
the user what happened and retry once with the fresh registry.

## Step 3: Execute

Follow the fetched page content as the skill's instructions. The page is the
single source of truth — do not mix in guesses about what the skill "probably"
does beyond what the page says.

## Fallback: no registry in context

The registry is injected by a SessionStart hook, which only runs in Claude Code.
On claude.ai and any other environment without hooks, there is no registry block —
query Notion directly instead. This path needs no local files.

1. **Find the database.** In order:
   - a `data_source_id` written into this skill (see "Web variant" in the plugin README),
   - `~/.claude/notion-skills/config.json` if the filesystem is reachable,
   - otherwise `notion-search` for the user's skills database (typically named
     "Agent Skills"), and confirm the match with the user before using it.
2. **Query it** with `notion-query-data-sources`. `id` is required — Step 2 fetches
   the page by it, and the query returns no id unless you ask for one:
   ```
   SELECT id, "Name", "Trigger", "Status", "Category", "Runtime"
   FROM "collection://<data_source_id>"
   ```
   Skip pages whose Status is draft/archived/disabled. Page through every result;
   stopping at the first batch silently hides whatever did not fit.
3. **Match and fetch** as in Steps 1–3 above.

Only re-query when the request might match a skill. Do not query on every turn.

If the plugin is installed but not configured (`/notion-skills:setup` never run)
and no database can be found, say so and point the user at that command.

## Listing skills

For "list my skills" style requests, present the registry as a table
(name / category / trigger). Link each skill as `https://notion.so/<page_id>`
so the user can click through — never show bare page IDs to the user.

## Notes

- Page **content** edits in Notion take effect immediately (fetched live).
  Only name/trigger/status changes need a sync.
- The registry cache lives at `~/.claude/notion-skills/registry.md`; config at
  `~/.claude/notion-skills/config.json`.
