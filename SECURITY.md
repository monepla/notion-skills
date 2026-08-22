# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/monepla/notion-skills/security/advisories/new)**
(the repository's *Security* tab → *Report a vulnerability*). That channel is
private to the maintainers until an advisory is published.

Please do not open a public issue for a security problem.

Include what you would want if you were fixing it: the version, the transport
(`token` / `ntn` / `mcp`), what an attacker has to control, and what they get.
Reports are handled on a best-effort basis by a small team; there is no service
commitment attached to that.

## The threat model that is specific to this plugin

**Skill page content is executed as instructions.** That is the entire point of
the plugin — a page in your database is a SKILL.md that the model follows. The
consequence is direct:

> Whoever can edit a page in the routed database can put instructions into your
> Claude sessions.

So the database is a trust boundary, not just storage:

- **Point the router at a private database you control.** A shared team database
  means every editor can steer your sessions. A public one means anyone can.
- Treat granting edit access to that database as equivalent to granting the
  ability to run commands as you — because a skill page can tell the model to.
- The same applies to `Trigger` text, not only page bodies: triggers decide *when*
  a page gets pulled into context.
- If you must use a shared database, keep it to skills whose content you review,
  and remember that a page's content is fetched **live** on every use — an edit
  takes effect immediately, with no sync and no version pin.

This is a property of the design rather than a bug, which is why it is documented
rather than fixed. A report that a shared database lets its editors inject
instructions is working as described; a report that a *non-editor* can, is not.

## What the plugin itself does

Stated plainly so you can check it against the code:

- **Network.** The only host contacted is `api.notion.com`, and only to read your
  skills database. There is no telemetry, no analytics, no crash reporting, and
  no update check. Requests are `POST …/query` and `GET …/databases/{id}` —
  reads only; nothing in this plugin writes to your Notion.
- **Credentials.** The plugin never writes a token to disk. It uses
  `NOTION_API_TOKEN` from your environment, or delegates to the `ntn` CLI, which
  keeps its token in your OS keychain. Your Notion credential is only ever sent
  to Notion. Nothing reads your keychain, `~/.aws`, `~/.ssh`, browser storage, or
  any credential belonging to another service.
- **Hooks.** One, `SessionStart`. It reads `~/.claude/notion-skills/config.json`
  and `registry.md` and prints the registry. It makes no network call itself; if
  the cache is past `ttl_hours` it starts a detached `sync.mjs` for the *next*
  session. There is no `UserPromptSubmit`, `PreToolUse` or `PostToolUse` hook —
  the plugin does not observe your prompts or your tool calls.
- **State.** Everything user-specific stays in `~/.claude/notion-skills/`
  (override with `NOTION_SKILLS_HOME`). Nothing is written inside the plugin
  directory, and uninstalling leaves both that state and your Notion untouched.

### Turning it off

| | |
|---|---|
| `NOTION_SKILLS_DISABLE=1` | No injection for that session |
| `"injection": "off"` in the config | No injection at all; the router queries Notion on demand |
| `"transport": "mcp"` in the config | No background sync; nothing runs unless you ask for it |
| `claude plugin uninstall notion-skills@notion-skills` | Removes the plugin; your state and database remain |

## Supported versions

The latest release. Fixes go onto `main` and ship in the next tag; there are no
maintained release branches.
