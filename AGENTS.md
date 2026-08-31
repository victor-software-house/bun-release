# bun-release

Library for public-npm OIDC → `BUN_CONFIG_TOKEN` → `bun publish`. GitHub is
[`victor-software-house/bun-release`][repo]. The npm name is unscoped
**`bun-release`**.

[`CLAUDE.md`](./CLAUDE.md) is only `@AGENTS.md`.

## Layout

| Path | Role |
| --- | --- |
| [`src/npm/`](./src/npm/) | Registry HTTP: generated SDK + pack/PUT/trust helpers |
| [`src/generated/`](./src/generated/) | Hey API output — regenerate, do not edit. `output.header` prepends `// @ts-nocheck` (Ky client does not typecheck under `exactOptionalPropertyTypes`). |
| [`vendor/CONTRACT.md`](./vendor/CONTRACT.md) | pnpm 12 pin, endpoint map, divergences — do not re-research |
| [`src/github/`](./src/github/) | GitHub Actions env output |
| [`src/release/`](./src/release/) | OIDC, changelog, tags, publish orchestration, bootstrap composer |
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
   `changeset version` + `bun update --lockfile-only`). The PR is opened with a
   GitHub App installation token (`vsh-changeset-version`), not `github.token`.
   The PR title is the commit title (`chore(release): version packages`).
4. Operator merges that PR. GitHub deletes the head branch
   (`delete_branch_on_merge`). CI then runs `mise run release:oidc`,
   `mise run release`, then `mise run release:tags`.

   If squash-merging from the web UI, clear the generated `Co-authored-by:`
   trailer.

Registry wire format is pinned in [`vendor/CONTRACT.md`](./vendor/CONTRACT.md)
(pnpm `v12.1.0` Rust). Local OpenAPI is [`vendor/npm-registry.yaml`](./vendor/npm-registry.yaml).

`0.0.0` is already on npm. Later first-package names use
`bootstrapNpmPackages` — not a long-lived token. The helper posts npm's web
login (`POST /-/v1/login` with `{ hostname }` and `npm-auth-type: web`; an
empty `{}` is treated as a publish and 401s), prints the URL and opens it (no
Enter prompt; `browser: false` prints only), and polls `doneUrl` with
Ky until 200 `{ token }` (`loginRetry` limit + `AbortSignal.timeout`; first GET
waits the poll interval; 404 and
empty 200 retry on the interval; 202 waits `max(interval, Retry-After ms)`). It packs
with `bun pm pack` using the operator environment (same as `bun install`).
Publish is `PUT /{escapedPackageName}` with
`Authorization: Bearer` and the documented publish document (`versions`,
`dist` integrity/shasum, `_attachments` base64 tarball) — bunfig and `.npmrc`
cannot redirect that PUT. A 401 otp
with `authUrl`/`doneUrl` uses the same web-auth helper, then retries the same
PUT with `npm-otp` (bun's TTY `get_otp` is never invoked). Missing packages
pack concurrently; PUTs stay serial because OTP is one-shot. Each accepted PUT
starts an independent public-packument visibility poll, and the next PUT starts
immediately. Bootstrap waits for all visibility polls together before serial
`GET`/`POST` `/-/package/<name>/trust` for GitHub + `createPackage` (same Bearer session;
trust requires `npm-otp` — a 401 with `authUrl`/`doneUrl` reuses the PUT web-auth
flow). A successful create response is final; do not immediately spend another
OTP on a redundant verification GET. Bootstrap waits two seconds between npmjs
trust packages and retries non-OTP 429 responses using `Retry-After` or capped
backoff. Never replay a one-time password after 429. It never invokes the
npm CLI or `bun publish`. The pack tarball temp dir is deleted in `finally`.

This is standing procedure, not one-shot migration: every new npm name hits
the same wall. Re-running it is a guard — existing versions skip publish,
matching trust is left alone, a mismatch fails. Delete the helper when npm
ships first-publish OIDC ([npm/cli#8544](https://github.com/npm/cli/issues/8544)).
The consumer mise task maps the same staged packages CI will publish; do not
hand-type a package list or add a bun-release CLI.

Operator-level `~/.npmrc` / `~/.bunfig.toml` can still apply to `bun pm pack`
(needed if pack ever resolves scoped deps). They cannot apply to publish:
the PUT is `fetch` to the npmjs URL with a Bearer session. CI publish is
still `bun publish` with `BUN_CONFIG_TOKEN`.

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
