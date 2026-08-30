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
hand-typed list. The helper does npm web login over `fetch`, a temporary
`HOME` so user-level registry mappings cannot participate, `bun publish`, then
GitHub trusted-publisher registration and verification. The session file is
removed in `finally`. Existing names skip publish and still verify trust.
Normal CI publish stays OIDC.

```ts
import { bootstrapNpmPackages } from 'bun-release';

await bootstrapNpmPackages(
	stagePlatforms().map(({ dir, name, version }) => ({
		directory: dir,
		name,
		version,
	})),
	'owner/repo',
	'release.yml',
);
```
