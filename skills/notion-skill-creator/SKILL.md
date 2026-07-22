---
name: notion-skill-creator
description: >
  Creates, edits, or archives a skill in the user's Notion skills database.
  Use when the user says: create a skill, add a skill, register a skill, turn this
  workflow into a skill, automate this as a skill, improve/update one of my Notion
  skills, disable/archive a skill, スキル作成, スキル追加, スキル登録, この作業をスキル化.
  Requires the notion-skills plugin to be set up (/notion-skills:setup).
  Do not use for generic questions about skills.
---

# Notion Skill Creator

Creates a new skill page in the user's Notion skills database and makes it
routable. The page content is the skill's full instruction set; the `Trigger`
property is what makes routing work.

## Prerequisites

Read `~/.claude/notion-skills/config.json` for:
- `data_source_id` — the target database
- `properties` — actual property names (defaults: Name / Trigger / Status / Category)

If the file is missing, stop and tell the user to run `/notion-skills:setup` first.

## Step 1: Gather (skip anything already clear from conversation)

1. **Skill name** — short, verb-first English kebab-case recommended (e.g. `triaging-inbox`)
2. **Purpose** — 1–2 sentences
3. **Trigger keywords** — comma-separated words/phrases that should activate it.
   Write *when to use it*, not *what it does*. Include synonyms, error messages,
   tool names — the words a user would actually type.
4. **Steps** — the main workflow
5. **Inputs / outputs** — what the user provides, what the skill produces
6. **Runtime** — where the skill can execute. Infer it from the steps and confirm:
   - `any` — knowledge, procedures, Notion operations (also usable by Notion AI / other agents)
   - `claude-code` — needs shell, repositories, local files, or MCP servers
   - `notion` — written specifically for Notion AI / Notion Agents

   Prefer `any` when possible: write steps in tool-neutral terms so the same
   skill works from Notion AI too. Only mark `claude-code` when local tools are
   genuinely unavoidable.

## Step 2: Create the page

Create a page in the database (via Notion MCP `notion-create-pages`, `ntn api v1/pages`,
or the REST API — whichever transport is available) with properties:

- `<Name>`: skill name
- `<Trigger>`: trigger keywords
- `<Status>`: `active` (use `draft` if the user wants to review first)
- `<Category>`: if the database has one
- `<Runtime>`: `any` / `claude-code` / `notion` (if the database has the property;
  suggest adding it when missing — it lets Notion AI skip non-portable skills)

Page content template:

```markdown
# {skill name}

{purpose}

## Config
- Response language: {user's language}
- Required tools: {MCP servers / CLIs this skill needs}

## Inputs
{what the user provides}

## Outputs
{what the skill produces}

## Steps
### 1. {step}
{detailed instructions}

## Error handling
{expected failures and what to do}

## Constraints
{what this skill must never do}
```

## Step 3: Register

Run `/notion-skills:sync` (or perform the sync yourself per that skill's
instructions). Confirm the new skill appears in the registry, then report the
page URL (`https://notion.so/<page_id>`) and its trigger keywords.

## Editing an existing skill

1. Fetch the current page content
2. Apply the requested change to the page
3. If name/trigger/status changed, run `/notion-skills:sync`

## Archiving a skill

Set `<Status>` to `archived`, then run `/notion-skills:sync`. Statuses listed in
`excluded_status` (default: archived, draft, disabled) drop out of the registry.

## Quality rules for trigger keywords

- ❌ Workflow summary as description — the router may act on it without reading the page
- ✅ Activation conditions only: the words, symptoms, and tool names a user would type
- Avoid overlapping keywords with the user's other skills — check the registry first
  and warn the user about collisions before creating.
