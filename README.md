# notion-skills

Turn a Notion database into your personal, auto-syncing **skill store** for
Claude Code.

Each row in your database is a skill: the page content is the instruction set,
and a `Trigger` property holds the keywords that should activate it. This
plugin injects a compact registry of your skills into every session, routes
matching requests to the right Notion page, and keeps the registry in sync as
you add, rename, or archive skills — no code changes, no plugin updates.

```
┌──────────────────────┐        sync (script or /sync)       ┌───────────────────────────┐
│  Your Notion DB      │ ──────────────────────────────────▶ │ ~/.claude/notion-skills/  │
│  Name│Trigger│Status │                                     │  config.json  registry.md │
│  + page content      │ ◀── fetched live on every use ──┐   └────────────┬──────────────┘
└──────────────────────┘                                 │                │ SessionStart hook
                                                         │                ▼
                                            ┌────────────┴────────────────────────┐
                                            │  Claude session                     │
                                            │  registry in context → router skill │
                                            └─────────────────────────────────────┘
```

## Install

```
/plugin marketplace add monepla/notion-skills
/plugin install notion-skills@notion-skills
```

Then, in any session:

```
/notion-skills:setup https://www.notion.so/<your-skills-database>
```

No database yet? Run `/notion-skills:setup` with no arguments — if your Notion
MCP connector is available, it offers to create one with the right schema.

## Database schema

| Property | Type | Required | Purpose |
|---|---|---|---|
| `Name` | title | ✔ | Skill name |
| `Trigger` | rich_text | ✔ | Comma-separated activation keywords |
| `Status` | select / status | – | `active` / `draft` / `archived` (`draft`, `archived`, `disabled` are excluded) |
| `Category` | select | – | Grouping in listings |
| page content | – | ✔ | The skill's full instructions (its SKILL.md) |

Different property names (e.g. a Japanese schema)? Map them in
`~/.claude/notion-skills/config.json` → `properties` — no renaming needed.

## How updates flow

| You change… | Takes effect |
|---|---|
| Page **content** | Immediately (fetched live on every use) |
| Name / Trigger / Status, new or archived skills | Next sync: automatic when the cache is older than `ttl_hours` (default 24h), or instantly via `/notion-skills:sync` |
| The plugin itself | `/plugin` → update |

## Auth — three ways, pick what you already have

| You have | Sync runs | Notes |
|---|---|---|
| `NOTION_API_TOKEN` env var | Automatically, in the background | Create an [internal integration](https://www.notion.so/profile/integrations) and share your DB with it |
| [Notion CLI](https://developers.notion.com/docs/get-started-with-the-notion-cli) (`ntn login`) | Automatically, in the background | Token stays in your OS keychain |
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

```jsonc
{
  "data_source_id": "…",           // set by setup
  "transport": "auto",              // auto | token | ntn | mcp
  "ttl_hours": 24,                  // cache age before background refresh
  "injection": "session",           // session | off (off = router queries Notion directly)
  "properties": { "name": "Name", "trigger": "Trigger", "status": "Status", "category": "Category" },
  "excluded_status": ["archived", "draft", "disabled"]
}
```

Context cost: the injected registry is one line per skill (~15–25 tokens each).
20 skills ≈ 400 tokens per session. Set `"injection": "off"` to trade that for
an on-demand Notion query.

## Security

**Skill page content is executed as instructions.** Point the router only at a
private database you control. A shared or public database would let anyone who
can edit those pages inject instructions into your sessions. The sync scripts
are read-only against the Notion API.

## 日本語での概要

Notion データベースを Claude Code の「スキルストア」にするプラグイン。
DB の各ページ＝1スキル（本文が指示書、`Trigger` プロパティが発火キーワード）。

- 導入: 上記 Install の2コマンド → `/notion-skills:setup <DBのURL>`
- ページ**本文**の編集は即時反映（毎回ライブ取得）。名前・トリガー・Status の変更は
  自動同期（既定24h）か `/notion-skills:sync` で反映
- 認証は `NOTION_API_TOKEN` / `ntn` CLI / Notion MCP コネクタの3系統。トークンを
  ファイルに書くことはない
- 日本語プロパティ名の DB は `config.json` の `properties` でマッピング可能
- **注意**: スキル本文は指示として実行される。ルーティング先は必ず自分だけが
  編集できる private DB にすること

## License

MIT
