# bun-release

Library for public-npm OIDC → `BUN_CONFIG_TOKEN` → `bun publish`. GitHub is
[`victor-software-house/bun-release`][repo]. The npm name is unscoped
**`bun-release`**.

[`CLAUDE.md`](./CLAUDE.md) is only `@AGENTS.md`.

## Layout

| Path | Role |
| --- | --- |
| [`src/`](./src/) | Packument lookup, OIDC handshake, one-time npm bootstrap, changelog slice, tag peel, publish/tag orchestration |
| [`test/`](./test/) | bun tests against `dist` |
| [`mise-tasks/`](./mise-tasks/) | This repo's own release tasks; they import `bun-release` from `dist` |

Source imports use `@release/*`. `mise-tasks` and tests import the published
package name `bun-release` after `build`. This repo lists `"bun-release": "."`
as a devDependency so Bun can resolve that name to `dist` before the first
npm publish. The root manifest is `@repo/package.json`. Relative imports are
forbidden.

## Tasks

```bash
mise run verify
```

## Release discipline

Versioning is **changeset-driven — CI owns the bump, publish, tag, and GitHub
Release.** Registry is public npm with OIDC trusted publishing. Runners are
GitHub-hosted `ubuntu-24.04`. A GitHub Release is changelog notes plus the `v*`
tag.

1. Author a `.changeset/*.md` file. Default bump is `patch`.
2. Commit and push to `main` (or merge a PR).
3. `changesets/action` opens a **"Version Packages" PR** (`mise run version` →
   `changeset version` + `bun update --lockfile-only`). The PR title is the
   commit title (`chore(release): version packages`).
4. Operator merges that PR. GitHub deletes the head branch
   (`delete_branch_on_merge`). CI then runs `mise run release:oidc`,
   `mise run release`, then `mise run release:tags`.

   If squash-merging from the web UI, clear the generated `Co-authored-by:`
   trailer.

`0.0.0` is already on npm. Later first-package names use
`bootstrapNpmPackages` — not a long-lived token. The helper posts npm's web
login (`POST /-/v1/login`), opens the printed URL, polls `doneUrl` for a
two-hour session, writes that token into a **temporary** `HOME/.npmrc`, runs
`bun publish --access public --registry`, then `GET`/`POST` `/-/package/<name>/trust`
for GitHub + `createPackage` on the given workflow file. It never invokes the
npm CLI. Auth never leaves the sandbox; `finally` deletes the temp home.

Operator-level `~/.npmrc` / `~/.bunfig.toml` that map
`@victor-software-house` to GitHub Packages do not apply: publish env is
`PATH`, `HOME=<sandbox>`, `TMPDIR` only.

This package cannot `bun add bun-release` for its first publish. Its mise-tasks
import `dist` after `depends = ["build"]`.

- **Never run `changeset version` or `changeset publish` locally.** Never
  hand-edit `package.json` version or `CHANGELOG.md` after the `0.0.0` scaffold.
- `mise run release:oidc` writes `BUN_CONFIG_TOKEN` to `GITHUB_ENV`. The next
  step is `bun publish --access public --tolerate-republish`. Bun reads the
  token from [`bunfig.toml`](./bunfig.toml). Do not use `bunx npm` or
  `NPM_CONFIG_FORCE`.
- Do not add `NPM_TOKEN` / `NODE_AUTH_TOKEN`. Do not store a publish token in
  1Password or fnox. Do not pass `publish:` to `changesets/action`.
- Unscoped publish needs the **default registry** token in bunfig, not only the
  `@victor-software-house` scope line. Never add a repo `.npmrc`.
- Never `major` on `0.x` unless explicitly decided.

[repo]: https://github.com/victor-software-house/bun-release
