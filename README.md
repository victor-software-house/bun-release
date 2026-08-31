# bun-release

Library for public-npm OIDC publish with bun. Consumers keep thin mise file
tasks. This is not a CLI.

```bash
bun add bun-release
```

## Ongoing release (OIDC)

CI mints a short-lived token (`mise run release:oidc` → `BUN_CONFIG_TOKEN`),
then `bun publish --access public --tolerate-republish`. See [`AGENTS.md`](./AGENTS.md).

## First publication (browser session)

A new npm name cannot use OIDC until it exists and has a trusted publisher
([npm/cli#8544](https://github.com/npm/cli/issues/8544)). Call
`bootstrapNpmPackages` from a consumer mise task that already knows which
packages CI will publish — the same staged `package.json` files, not a
hand-typed list. The helper does npm web login over `fetch`, `bun pm pack`
in the operator environment, then `PUT`s the tarball to the given registry
(Bearer; 401 otp completes the same web auth and retries with `npm-otp`).
Missing packages are packed concurrently and PUT serially. Each accepted PUT
starts a concurrent public-packument visibility check without blocking the next
PUT. After all missing packages are visible, the helper registers GitHub trusted
publishing serially (`GET`/`POST` `/-/package/.../trust`, with the same 401 otp
flow). Existing trust is confirmed by GET; new trust is confirmed by the create
response without a redundant rate-limited GET. Existing names skip publish and
still confirm trust. Login is
`POST /-/v1/login` with `{ hostname }`
and `npm-auth-type: web` (yarn/npm web auth; `{}` is treated as a publish).
Poll `doneUrl` with Ky until 200. The URL is printed and opened
immediately; pass `browser: false` to print only. Normal CI publish stays
OIDC + `bun publish`.

Composable pieces (`loginWeb`, `packPublishDocument`, `putNpmPackageWithOtp`,
`ensureGithubTrust`, URL helpers) are exported from the package root.

```ts
import { bootstrapNpmPackages } from 'bun-release';

await bootstrapNpmPackages(
	[
		{ name: '@scope/pkg-darwin-arm64', version: '0.0.0', directory: './dist/npm/darwin-arm64' },
		{ name: '@scope/pkg-linux-x64', version: '0.0.0', directory: './dist/npm/linux-x64' },
	],
	'owner/repo',
	'release.yml',
);
```
