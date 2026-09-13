# notion-skills

Turn a Notion database into your personal, auto-syncing **skill store** for
Claude Code — no per-skill install step, and no copy of your skills on disk.

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

## Is this what you want? (vs. Notion's built-in skill install)

Notion can install a skill page straight to local agents — Claude Code, Codex,
Cursor, Gemini and Grok — via the **Install** control on the page. It saves the
skill to your computer, including `SKILL.md` and approved attached files, and you
invoke it as a slash command. That is first-party, covers more agents than this
plugin, and carries attachments. **If it covers you, use it.**

This plugin makes a different trade:

| | Notion's built-in install | notion-skills |
|---|---|---|
| Adding a skill | Install each page you want | Add the page — the whole database is the store |
| On disk | The skill is saved to your computer | No skill copy is written; only an index cache |
| Getting the content | From the installed copy | Fetched from the page at use time |
| Invoking | `/skill-name` | Trigger keywords, matched from the injected index and against each prompt |
| Attached files | Included | Page body only |
| Agents | Claude Code, Codex, Cursor, Gemini, Grok | Claude Code (plus Notion AI and claude.ai, below) |

So it suits you if you have **many** skills and do not want to install them one
at a time, or if you edit skills often and would rather not manage local copies
at all. It suits you less if you need attached files, or an agent other than
Claude Code.

The cost is context: the index is injected every session (see
[Configuration](#configuration-claudenotion-skillsconfigjson) for the measured
size, and `"injection": "off"` to turn it off).

## Requirements

- Claude Code with plugin support
- **Node.js 18+** on `PATH` — the hooks and the sync script run on it
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

That resolves the data source, checks your schema, writes the config and runs the
first sync in one command. No database yet? Run `/notion-skills:setup` with no
arguments — if your Notion MCP connector is available, it offers to create one
with the right schema.

The scripts also run on their own, if you would rather not go through a session:

```bash
node scripts/setup.mjs "<database URL>"                   # same thing, from a shell
node scripts/setup.mjs --dry-run --json "<database URL>"  # report, write nothing
node scripts/sync.mjs                                     # refresh the registry
```

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

| You have | `transport` | Sync runs | Notes |
|---|---|---|---|
| `NOTION_API_TOKEN` env var | `token` | Automatically, in the background | Create an [internal integration](https://www.notion.so/profile/integrations) and share your DB with it |
| [Notion CLI](https://developers.notion.com/cli/get-started/overview) (`curl -fsSL https://ntn.dev \| bash`, then `ntn login`) | `ntn` | Automatically, in the background | Token stays in your OS keychain |
| Notion MCP connector only | `mcp` | When you run `/notion-skills:sync` | Claude runs one query and hands the rows to the sync script |

`transport` defaults to `auto`, which prefers the token and falls back to `ntn`.
Naming one explicitly pins it: with `"transport": "ntn"` the keychain path is used
even if a token happens to be exported, and if the CLI is missing you get an error
saying so rather than a silent switch to something else.

All three end up in the same code: the MCP path differs only in *who* fetches the
rows. Claude runs

```sql
SELECT id, "Name", "Trigger", "Status", "Category", "Runtime" FROM "collection://<id>"
```

and passes the result to `sync.mjs --from-json`, which does the filtering,
sorting, truncation and escaping. Nothing hand-writes the registry format.

The token is never written to any file by this plugin.

## Commands & skills

| | |
|---|---|
| `/notion-skills:setup [DB URL]` | Point the plugin at your database, validate schema, first sync |
| `/notion-skills:sync` | Refresh the registry now |
| `notion-skill-router` | Routes matching requests to your Notion skills (automatic) |
| `notion-skill-creator` | "Turn this into a skill" — creates the page and registers it |
| `web-skill` | Builds the standalone claude.ai router described below |

Your skills are Notion pages, not installed skills: their names are not Skill tool
names or slash commands. When a prompt matches one, the prompt carries a short
`[notion-skills]` note with the page id, so the page is fetched on the first try —
even when the session-start registry reached the model only as a preview.

## Configuration (`~/.claude/notion-skills/config.json`)

Written by `setup`. Only `data_source_id` is required — every other key falls
back to the default shown.

```jsonc
{
  "data_source_id": "…",     // set by setup
  "transport": "auto",       // auto | token | ntn | mcp
  "ttl_hours": 24,           // cache age that triggers a background refresh
  "injection": "session",    // session | off (off = router queries Notion on demand)
  "prompt_match": "on",      // on | off — note the skills a prompt matches (matched locally)
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

The per-prompt note adds nothing to a prompt that matches no skill, and at most
three skill lines plus three lines of instructions to one that does.

## Web variant (claude.ai)

The SessionStart hook only runs in Claude Code, so on claude.ai there is no
injected registry. Build a standalone skill that queries Notion over the MCP
connector at request time instead:

```bash
node scripts/build-web-skill.mjs
```

This writes a **single** `SKILL.md` to `~/.claude/notion-skills/web-skill/`.
Upload it once as a skill in claude.ai (Settings → Capabilities).

The web variant carries **no skill list** — it queries your Notion database live
every time it runs, so it always sees the full, current set. That means:

- No rebuild when you add, rename, or archive skills — the live query picks them
  up. (Rebuild only if the database itself moves.)
- No 1024-character description limit to fight, and no splitting into multiple files.
- It needs no Notion access to *build* (only your `data_source_id` from config),
  so it works in every environment, including MCP-only claude.ai.

Requirements:

- The Notion connector must be enabled in claude.ai, with your skills database
  shared to it — the skill queries the database at runtime.
- Delete any router skill you uploaded under an earlier approach (e.g.
  `notion-skill-router-1` / `-2`). Those froze a skill list and will match stale
  page ids.

The output contains your database id, so it is written to your state directory —
never into this repository.

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
| `Unknown skill: <name>` right after asking for a Notion skill | The model passed a registry name to the Skill tool. A matching prompt should carry a `[notion-skills]` note with the page id: update the plugin, open a new session, and check `prompt_match` is not `off` |
| Fetching a skill 404s | The registry is stale — `/notion-skills:sync` |
| `no "Name" column (its columns: …)` | Your title column has a different name. Re-run setup with `--property name=<that column>` |
| `Every one of the N row(s) was filtered out` | Your `Status` values collide with `excluded_status` (default `archived`, `draft`, `disabled`) |
| `N row(s) carry no page id` | An MCP query without `id` in the `SELECT`. Re-query including it |
| `only the first page ("has_more": true)` | Page through the rest of the query and concatenate before syncing |
| `config.transport is "ntn" but …` / `is "token" but …` | You pinned a transport that isn't available. Install it, or set `"transport": "auto"` |
| Wrong property names | Map them in `config.json` → `properties`; don't rename anything in Notion |
| Fewer skills than you expected | Compare `count:` in the registry header against your database. `warn:` lines from the last sync name every page that was skipped and why |

Escape hatches:

- `NOTION_SKILLS_DISABLE=1` — skip registry injection and prompt matching for a session
- `NOTION_SKILLS_HOME=/path` — use a different state directory
- `NOTION_VERSION=…` — override the Notion API version used by the sync script
- `claude plugin uninstall notion-skills@notion-skills` — remove the plugin.
  Your `~/.claude/notion-skills/` state and your Notion database are untouched

## What it accesses

| | |
|---|---|
| Network | `api.notion.com` only, to read your skills database. No telemetry, no analytics, no update check |
| Notion writes | None. The scripts only `POST …/query` and `GET …/databases/{id}` |
| Credentials | `NOTION_API_TOKEN` from your environment, or the `ntn` CLI's keychain token. Never written to disk, never sent anywhere but Notion |
| Hooks | Two. `SessionStart` reads the two files in `~/.claude/notion-skills/` and prints the registry. `UserPromptSubmit` reads each prompt **on your machine**, compares it with `registry.md`, and prints a short note only when a skill matches — the prompt is not stored, logged or sent anywhere. No `PreToolUse` / `PostToolUse` hook — your tool calls are not observed |
| Files | `~/.claude/notion-skills/` only (override with `NOTION_SKILLS_HOME`) |

Opt out with `NOTION_SKILLS_DISABLE=1` (one session), `"injection": "off"` (no
injection at all), `"prompt_match": "off"` (no per-prompt note), or
`"transport": "mcp"` (no background sync). Full detail in
[SECURITY.md](SECURITY.md).

## Security

**Skill page content is executed as instructions.** Point the router only at a
private database you control. A shared or public database would let anyone who
can edit those pages inject instructions into your sessions — granting edit
access to that database is equivalent to granting the ability to run commands as
you. The sync scripts are read-only against the Notion API.

Report a vulnerability privately: [SECURITY.md](SECURITY.md).

## Development

```bash
node --test tests/*.test.mjs   # no dependencies, no network
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for local testing without installing
(`claude --plugin-dir …`) and the release process, and
[CHANGELOG.md](CHANGELOG.md) for what changed when.

## 日本語での概要

Notion データベースを Claude Code の「スキルストア」にするプラグイン。
**スキルごとの install 操作が要らず、スキルの実体をローカルに置かない**のが特徴。

> **Notion 標準の install との違い**: Notion はスキルページを Claude Code / Codex /
> Cursor / Gemini / Grok に install でき、SKILL.md と承認済み添付ファイルが PC に保存される。
> 公式で対応エージェントも多く添付にも対応しているので、**それで足りるならそちらを使うのがよい**。
> 本プラグインは代わりに「DB 丸ごとがストア（install 操作なし）」「実体を置かず本文は実行時取得」
> という別のトレードオフを取る。詳細は上の "Is this what you want?" を参照。

DB の各ページ＝1スキル（本文が指示書、`Trigger` プロパティが発火キーワード）。

スキルは「ただの Notion ページ」なので、ストアはエージェント非依存:
Claude Code（本プラグイン）・claude.ai（Notion コネクタ）・**Notion AI / Notion
エージェント（プラグイン不要で直接）**が同じスキル定義を実行できる。
`Runtime` プロパティ（`any` / `claude-code` / `notion`）で、ローカルツールが
必要なスキルを Notion AI 側にスキップさせられる（上記 "Use the same skills
from Notion AI" の推奨エージェント指示を参照）。

- 前提: Node.js 18+ が PATH にあること（フックと同期スクリプトが使う）
- 導入: 上記 Install の2コマンド → **新しいセッションで** `/notion-skills:setup <DBのURL>`。
  データソース解決・スキーマ検査・config 書き込み・初回同期を1コマンドで行う
- ページ**本文**の編集は即時反映（毎回ライブ取得）。名前・トリガー・Status の変更は
  自動同期（既定24h）か `/notion-skills:sync` で反映
- スキル名は Skill ツール名・スラッシュコマンドではない。プロンプトがスキルに一致すると、
  そのプロンプトにだけスキル名と page_id を数行添える（`UserPromptSubmit` フック）ので、
  セッション開始時の一覧がプレビューしか届かなくても初手でページを取得できる。
  照合はローカルで行い、プロンプトは保存も送信もしない。`"prompt_match": "off"` で無効化
- 認証は `NOTION_API_TOKEN` / `ntn` CLI / Notion MCP コネクタの3系統で、`config.json` の
  `transport` で明示指定できる（`auto` は token → ntn の順）。MCP のみの環境では
  Claude が1回クエリして結果を `sync.mjs --from-json` に渡す（レジストリを手書きしない）。
  トークンをファイルに書くことはない
- 日本語プロパティ名の DB は `config.json` の `properties`、または
  `setup.mjs --property name=スキル名` でマッピング可能（Notion 側の改名は不要）
- 通信先は `api.notion.com` のみ。テレメトリ・解析送信は無い（[SECURITY.md](SECURITY.md)）
- **注意**: スキル本文は指示として実行される。ルーティング先は必ず自分だけが
  編集できる private DB にすること（そのDBの編集権限＝セッションへの指示注入権限）

## License

MIT
