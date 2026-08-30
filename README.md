# bun-release

Library for public-npm OIDC publish with bun. Consumers keep thin mise file
tasks. This is not a CLI.

```bash
bun add bun-release
```

CI mints a short-lived token (`mise run release:oidc` → `BUN_CONFIG_TOKEN`),
then `bun publish --access public --tolerate-republish`. See [`AGENTS.md`](./AGENTS.md).
