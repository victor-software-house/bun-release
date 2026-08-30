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

A new npm name cannot use OIDC until it exists and has a trusted publisher.
`bootstrapNpmPackages` does that once: npm web login over `fetch`, a temporary
`HOME` so user-level registry mappings cannot participate, `bun publish`, then
GitHub trusted-publisher registration and verification. The session file is
removed in `finally`. Normal CI publish stays OIDC.

```ts
import { bootstrapNpmPackages } from 'bun-release';

await bootstrapNpmPackages(
	[{ name: '@scope/pkg-darwin-arm64', version: '0.0.0', directory: stagedDir }],
	'owner/repo',
	'release.yml',
);
```
