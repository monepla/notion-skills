# Contributing

Thanks for looking. This is a small plugin with a deliberately small surface —
issues that report a concrete misbehaviour are the most useful thing you can
send.

## Requirements

- Node.js 18 or newer. That is the whole toolchain: the plugin has no
  dependencies and no build step, and there is no `package.json` on purpose.
- Claude Code, if you want to exercise the plugin rather than just the scripts.

## Running the tests

```bash
node --test 'tests/*.test.mjs'
```

The suite makes **no network calls**. Everything either runs against fixtures or
drives the shipped scripts through their `--from-json` path, which is also the
real code path for MCP-only users. Quote the glob — an unquoted one is expanded
by the shell before Node sees it, and `node --test tests/` reads `tests` as a
name filter rather than a directory.

CI runs the same command on Node 18, 20 and 22, plus manifest checks
(`.github/workflows/ci.yml`).

## Trying a change without installing it

```bash
claude --plugin-dir /path/to/your/clone
```

That loads the plugin from disk for one session, so you can iterate without
touching your installed copy. To check the manifests the way the marketplace
will:

```bash
claude plugin validate /path/to/your/clone
```

Your own state lives in `~/.claude/notion-skills/`. Point the scripts somewhere
disposable while testing:

```bash
NOTION_SKILLS_HOME=/tmp/ns-test node scripts/setup.mjs --dry-run --json "<database URL>"
```

## What a good pull request looks like

- **One thing.** A fix or one capability, not a sweep.
- **A test that fails without it.** The suite exists because the bugs this
  project has actually shipped — an MCP query that selected no page id, a config
  key that was documented but never read — were all things a test would have
  caught immediately, and all of them failed *quietly*.
- **Fix the class, not the instance.** The missing-`id` bug was in three files.
  If you find a defect, grep for the same shape elsewhere before you send the fix,
  and say in the PR what you searched for.
- **No new dependencies**, and no new network destinations. The only host this
  plugin contacts is `api.notion.com`, and that is part of its stated purpose;
  anything else needs discussion first.
- Keep user state out of the repository. Page IDs, database IDs and registries
  belong in `~/.claude/notion-skills/`, never in a commit. A test enforces this.

## Releasing

For maintainers. The marketplace pins a commit SHA, so a release is a real
checkpoint rather than a label on a moving branch.

1. Merge the change.
2. Bump `version` in `.claude-plugin/plugin.json`. Semver against the *user's*
   experience: a changed config key or command flag is breaking; a new one is a
   minor; a fix that changes no interface is a patch.
3. Add the release to `CHANGELOG.md`, with the commits it is based on.
4. Tag it:
   ```bash
   claude plugin tag .
   ```
   That creates `notion-skills--v<version>` after checking that `plugin.json` and
   the enclosing marketplace entry agree. If it refuses, fix the disagreement it
   names — do not hand-tag around it. The equivalent by hand is
   `git tag notion-skills--v<version> && git push origin notion-skills--v<version>`.
5. Publish the release notes:
   ```bash
   gh release create notion-skills--v<version> --title notion-skills--v<version> --notes-file <(…)
   ```
6. If the plugin is listed in a marketplace that pins a SHA, open the update
   there with `git rev-parse notion-skills--v<version>`.

Users then take it with `claude plugin marketplace update notion-skills` followed
by `claude plugin update notion-skills@notion-skills`, and a restart.

## Support

Best effort, from a small team, with no service commitment. Bug reports get
priority; feature requests are considered but may sit. English and Japanese are
both fine.

Security issues do **not** go in the issue tracker — see [SECURITY.md](SECURITY.md).
