#!/usr/bin/env bun
//MISE description="Mint a short-lived npm OIDC token into BUN_CONFIG_TOKEN"
//MISE dir="{{ config_root }}"
//MISE depends=["build"]

import { env } from 'node:process';
import { name } from '@repo/package.json' with { type: 'json' };
import { npmOidcPublishToken, writeMaskedGithubEnv } from 'bun-release';
import { match, P } from 'ts-pattern';

await match(env.GITHUB_ENV)
	.with(P.string.minLength(1), async (path) => {
		const token = await npmOidcPublishToken(name, env);
		await writeMaskedGithubEnv(path, token);
	})
	.otherwise(() => {
		throw new Error('release:oidc writes BUN_CONFIG_TOKEN to GITHUB_ENV (CI only)');
	});
