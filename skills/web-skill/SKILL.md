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
- To delete any previously uploaded router skill whose name is not in this build
  (e.g. an old `-dev` / `-general` split, or fewer files than before). Stale
  uploads keep matching old page ids and cause double registration.

## MCP-only

Without a script transport (claude.ai has neither `NOTION_API_TOKEN` nor `ntn`),
build the files by hand. **The build is only correct if every active skill lands
in exactly one file — losing one silently makes it unroutable on the web.** Follow
these steps and do not skip the count check.

### Step 1: Get the complete active set

Query the database and page through **every** result — do not stop at the first
batch:

```
SELECT "Name", "Trigger", "Status", "Category", "Runtime"
FROM "collection://<data_source_id>"
```

Drop pages whose Status is in `excluded_status` (default draft/archived/disabled)
and any page id in `excluded_pages`. Call the remaining list the **target set**
and record its exact count `N` (e.g. 60). Keep this list; it is the source of
truth for the check in Step 4.

### Step 2: Assign each skill to exactly one file

Split only to satisfy the 1024-character limit — nothing else. Concretely:

- Start with one file. Build its description (see Step 3). If it would exceed
  1024 characters, split into more files.
- Assign **every** skill in the target set to exactly one file. Do not group by
  taste, do not summarize, do not drop a skill because a file "feels full" — add
  another file instead.
- Naming: `notion-skill-router-1`, `-2`, … matching the script. Do not invent
  category names like `-dev` / `-general`; a different scheme leaves stale files
  behind on the next rebuild and causes double registration.

### Step 3: Per-file content

Each file's frontmatter `description` must list the names (and, budget
permitting, up to two trigger keywords each) of **that file's** skills, kept
under 1024 characters. The body carries a registry table of
`name / runtime / page id / triggers` for that file's skills, plus the same
"Use" / fallback instructions the script emits.

### Step 4: Verify completeness before finishing (mandatory)

- Sum the registry rows across all files. It **must equal `N`** from Step 1.
- Every name in the target set must appear in exactly one file's description —
  no duplicates, no omissions.
- If the totals disagree, you dropped or double-counted a skill: fix it before
  reporting done. Do not report the build as complete until the counts match.

Report `N`, the file count, and the per-file skill counts so the user can see
the total reconciles.
