# notion-skills

Turn a Notion database into your personal, auto-syncing **skill store** for
Claude Code.

Each row in your database is a skill: the page content is the instruction set,
and a `Trigger` property holds the keywords that should activate it. This
plugin injects a compact registry of your skills into every session, routes
matching requests to the right Notion page, and keeps the registry in sync as
you add, rename, or archive skills — no code changes, no plugin updates.

Because skills are plain Notion pages — not code — the same store is
**agent-agnostic**: Claude Code (this plugin), claude.ai (Notion connector),
**Notion AI / Notion Agents (directly, no plugin needed)**, and anything else
that can read Notion all execute the same skill definitions. Write a workflow
once, run it from wherever you happen to be working.

```
┌──────────────────────────┐                          ┌───────────────────────────┐
│ Your Notion DB           │   sync: script or /sync  │ ~/.claude/notion-skills/  │
│ Name │ Trigger │ Status  │ ───────────────────────▶ │  config.json              │
│ Runtime │ Category       │                          │  registry.md              │
│ + page content           │                          └─────────────┬─────────────┘
└──────────────────────────┘                                        │
              ▲                                    SessionStart hook │ injects registry
              │                                                      ▼
              │  page content fetched   ┌─────────────────────────────────────────┐
              └──────── live ───────────┤ Claude session → notion-skill-router    │
                                        └─────────────────────────────────────────┘
```

## Requirements

- Claude Code with plugin support
- **Node.js 18+** on `PATH` — the SessionStart hook and the sync script run on it
- A Notion database you can edit, plus one of the three auth options below

## Install

In a Claude Code session:

```
/plugin marketplace add monepla/notion-skills
/plugin install notion-skills@notion-skills
```

Or from a terminal:

```bash
claude plugin marketplace add monepla/notion-skills
claude plugin install notion-skills@notion-skills
```

Then, in a **new** session (the hook loads at session start):

```
/notion-skills:setup https://www.notion.so/<your-skills-database>
```

No database yet? Run `/notion-skills:setup` with no arguments — if your Notion
MCP connector is available, it offers to create one with the right schema.

## Database schema

| Property | Type | Required | Purpose |
|---|---|---|---|
| `Name` | title | ✔ | Skill name. Pages with an empty name are skipped |
| page content | – | ✔ | The skill's full instructions (its SKILL.md) |
| `Trigger` | rich_text | recommended | Comma-separated activation keywords. Without it, routing falls back to matching the skill name alone |
| `Status` | select / status | – | Pages whose value is in `excluded_status` (default: `draft`, `archived`, `disabled`) drop out of the registry. **Pages with no status are included**, so the property is optional |
| `Category` | select | – | Grouping in listings |
| `Runtime` | select | – | `any` (portable — default when absent) / `claude-code` (needs shell, repos, MCP) / `notion` (Notion AI only) |

Different property names (e.g. a Japanese schema)? Map them in
`~/.claude/notion-skills/config.json` → `properties` — no renaming needed.

## How updates flow

| You change… | Takes effect |
|---|---|
| Page **content** | Immediately (fetched live on every use) |
| Name / Trigger / Status, new or archived skills | Next sync: automatic when the cache is older than `ttl_hours` (default 24h), or instantly via `/notion-skills:sync` |
| The plugin itself | `claude plugin update notion-skills@notion-skills` (or `/plugin`) — restart required |

## Auth — three ways, pick what you already have

| You have | Sync runs | Notes |
|---|---|---|
| `NOTION_API_TOKEN` env var | Automatically, in the background | Create an [internal integration](https://www.notion.so/profile/integrations) and share your DB with it |
| [Notion CLI](https://developers.notion.com/cli/get-started/overview) (`curl -fsSL https://ntn.dev \| bash`, then `ntn login`) | Automatically, in the background | Token stays in your OS keychain |
| Notion MCP connector only | When you run `/notion-skills:sync` | Claude performs the sync in-session |

The token is never written to any file by this plugin.

## Commands & skills

| | |
|---|---|
| `/notion-skills:setup [DB URL]` | Point the plugin at your database, validate schema, first sync |
| `/notion-skills:sync` | Refresh the registry now |
| `notion-skill-router` | Routes matching requests to your Notion skills (automatic) |
| `notion-skill-creator` | "Turn this into a skill" — creates the page and registers it |

## Configuration (`~/.claude/notion-skills/config.json`)

Written by `setup`. Only `data_source_id` is required — every other key falls
back to the default shown.

```jsonc
{
  "data_source_id": "…",     // set by setup
  "transport": "auto",       // auto | token | ntn | mcp
  "ttl_hours": 24,           // cache age that triggers a background refresh
  "injection": "session",    // session | off (off = router queries Notion on demand)
  "properties": {            // map logical fields → your database's property names
    "name": "Name",
    "trigger": "Trigger",
    "status": "Status",
    "category": "Category",
    "runtime": "Runtime"
  },
  "excluded_status": ["archived", "draft", "disabled"],
  "max_trigger_chars": 100   // trigger text is truncated at a comma boundary
}
```

Context cost: one line per skill — name, page ID, runtime, category, and
trigger keywords. Measured on a 66-skill database: 9.9 KB, roughly 2.5k tokens
per session (Japanese text; a mostly-English registry of the same size is
smaller). A typical 20-skill store lands well under 1k. Set
`"injection": "off"` to trade that for an on-demand Notion query.

## Use the same skills from Notion AI

The database is the skill store; this plugin is just the Claude Code adapter.
Notion AI / Notion Agents can consume it directly — add this to your Notion
agent's custom instructions:

> When a request matches the Trigger keywords of a page in **[link your skills
> database]**, open that page and follow its content as instructions. Skip
> pages whose Status is draft/archived or whose Runtime is `claude-code`.

Guidelines that make skills portable:

- Write steps in tool-neutral terms ("create a page in DB X", not "run
  `ntn api …`") whenever the workflow allows it, and set `Runtime: any`.
- Mark skills that genuinely need local tools (shell, repositories, MCP
  servers) as `Runtime: claude-code` so Notion AI knows to skip them.
- Page content edits propagate to **all** runtimes immediately — one edit,
  every agent updated.

## Troubleshooting

| Symptom | Check |
|---|---|
| No `[notion-skills]` line at session start | Is Node.js on `PATH`? Is the plugin enabled (`claude plugin list`)? Hooks load at session start — open a new session |
| "Not configured yet" | Run `/notion-skills:setup <DB URL>` |
| A new Notion skill isn't routed | `Status` not in `excluded_status`? Then `/notion-skills:sync` (or wait for the TTL refresh) |
| Fetching a skill 404s | The registry is stale — `/notion-skills:sync` |
| Sync says "Registry came out empty" | `data_source_id` or `properties` in `config.json` don't match the database |
| Wrong property names | Map them in `config.json` → `properties`; don't rename anything in Notion |

Escape hatches:

- `NOTION_SKILLS_DISABLE=1` — skip registry injection for a session
- `NOTION_SKILLS_HOME=/path` — use a different state directory
- `NOTION_VERSION=…` — override the Notion API version used by the sync script
- `claude plugin uninstall notion-skills@notion-skills` — remove the plugin.
  Your `~/.claude/notion-skills/` state and your Notion database are untouched

## Security

**Skill page content is executed as instructions.** Point the router only at a
private database you control. A shared or public database would let anyone who
can edit those pages inject instructions into your sessions. The sync scripts
are read-only against the Notion API.

## 日本語での概要

Notion データベースを Claude Code の「スキルストア」にするプラグイン。
DB の各ページ＝1スキル（本文が指示書、`Trigger` プロパティが発火キーワード）。

スキルは「ただの Notion ページ」なので、ストアはエージェント非依存:
Claude Code（本プラグイン）・claude.ai（Notion コネクタ）・**Notion AI / Notion
エージェント（プラグイン不要で直接）**が同じスキル定義を実行できる。
`Runtime` プロパティ（`any` / `claude-code` / `notion`）で、ローカルツールが
必要なスキルを Notion AI 側にスキップさせられる（上記 "Use the same skills
from Notion AI" の推奨エージェント指示を参照）。

- 前提: Node.js 18+ が PATH にあること（フックと同期スクリプトが使う）
- 導入: 上記 Install の2コマンド → **新しいセッションで** `/notion-skills:setup <DBのURL>`
- ページ**本文**の編集は即時反映（毎回ライブ取得）。名前・トリガー・Status の変更は
  自動同期（既定24h）か `/notion-skills:sync` で反映
- 認証は `NOTION_API_TOKEN` / `ntn` CLI / Notion MCP コネクタの3系統。トークンを
  ファイルに書くことはない
- 日本語プロパティ名の DB は `config.json` の `properties` でマッピング可能
- **注意**: スキル本文は指示として実行される。ルーティング先は必ず自分だけが
  編集できる private DB にすること

## License

MIT
