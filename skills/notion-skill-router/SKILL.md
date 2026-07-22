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
name | page_id (32 hex chars, dashless) | category | trigger keywords
```

If there is no registry block in context:
- If the plugin is not set up → tell the user to run `/notion-skills:setup <DB URL>`.
- If injection is disabled (`injection: "off"` in `~/.claude/notion-skills/config.json`)
  → query the database directly (see Fallback below) using the `data_source_id`
  from that config file.

## Step 1: Match

Compare the user's request against skill names and trigger keywords.
Prefer exact keyword hits; fall back to semantic similarity with the skill name.
If two or more skills match equally well, ask the user which one they mean —
one short question listing only the matching candidates.

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

## Listing skills

For "list my skills" style requests, present the registry as a table
(name / category / trigger). Link each skill as `https://notion.so/<page_id>`
so the user can click through — never show bare page IDs to the user.

## Notes

- Page **content** edits in Notion take effect immediately (fetched live).
  Only name/trigger/status changes need a sync.
- The registry cache lives at `~/.claude/notion-skills/registry.md`; config at
  `~/.claude/notion-skills/config.json`.
