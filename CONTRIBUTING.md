# Contributing

## Commits and pull requests

Pull requests are **squash-merged**: each one lands on `main` as a single commit whose message is the PR's title and description. The title is also the line the change gets in the changelog, so it follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), and a check on every PR enforces it.

### Title

```
<type>(<scope>): <summary>
```

- **type** says what kind of change it is, and decides the next version:

  | Type | For | Version |
  | --- | --- | --- |
  | `feat` | something new the user can do or see | minor |
  | `fix` | something that was wrong for the user | patch |
  | `perf` | faster or lighter, same behaviour | patch |
  | `refactor` | code reorganised, same behaviour | none |
  | `docs` | README, docs, comments | none |
  | `test` | tests only | none |
  | `build` / `ci` | packaging, dependencies, workflows | none |
  | `chore` | anything else that users never notice | none |
  | `revert` | undoes an earlier commit | patch |

  A breaking change adds `!` after the scope (`feat(memory)!: …`) or a `BREAKING CHANGE: …` footer, and bumps the major version.

- **scope** is the part of the app it touches, one of: `claude`, `codex`, `opencode`, `antigravity`, `ssh`, `main-agent`, `overview`, `sidebar`, `agent-view`, `composer`, `voice`, `memory`, `skills`, `settings`, `session-map`, `research`, `remote-control`, `i18n`, `release`, `deps`. Leave it out when a change spans the whole app.
- **summary** is an imperative verb phrase in lowercase, with no closing period, and at most 72 characters for the whole title: `fix(sidebar): center the image remove button`, not `Fixed: The remove button is now centred.`
- **One change per title.** A semicolon or a second "and" in it usually means two pull requests.

### Description

Write the why before the what, as in [How to Write a Git Commit Message](https://cbea.ms/git-commit/):

1. **Summary:** what changes for the user, and the problem or old behaviour behind it.
2. **Changes:** the key decisions and trade-offs, not a replay of the diff.
3. **Testing:** what was run and what was checked by hand.
4. `Fixes #123` (or `Refs #123` for partial work) at the end.

The PR template has these sections.

### Example

```
fix(codex): show MCP approval requests on the agent card

Codex's browser and computer use ask before using an app ("Allow Computer
Use to use Google Chrome?") through an MCP elicitation. Every elicitation
was cancelled, so Codex took it as a refusal and said it had no browser.

Yes/no elicitations now become approvals: Allow once, Allow for this
session, Deny. Forms that ask for details are still declined, with a note.

Fixes #123
```

### Commits on a branch

Only the squashed commit reaches `main`, so commits on a branch are free-form, but writing them the same way keeps the PR easy to review. To get the template in your editor:

```sh
git config commit.template .gitmessage
```

## Releases

Releases are cut by [release-please](https://github.com/googleapis/release-please-action):

1. Every merge to `main` updates a release PR, **chore: release vX.Y.Z**. It holds the next version (from the `feat`, `fix` and breaking changes merged since the last release), the version bump in `app/package.json` and `package-lock.json`, and the new section of `CHANGELOG.md`.
2. Merging that PR tags `vX.Y.Z` and creates the GitHub release with the changelog as its notes.
3. The same workflow builds the macOS DMG and the Windows installer and attaches them to the release.

Don't change the version by hand. To release, merge the release PR.

## Tests

From `app/`:

```sh
npx tsc --noEmit -p .
npx vitest run
npm run build && npx vitest run --config vitest.e2e.config.ts
```

Tests that call the real CLIs or SSH hosts are opt-in (`AMW_E2E_REAL=1`, `AMW_E2E_SSH_HOST=<alias>`); each file's header says how to run it.
