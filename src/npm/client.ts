import type { Auth, Client } from '@release/generated/client';
import { createClient, createConfig } from '@release/generated/client';
import { trailingSlash } from '@release/npm/url';
import { name, version } from '@repo/package.json' with { type: 'json' };
import { match, P } from 'ts-pattern';

/** pnpm `DEFAULT_FETCH_TIMEOUT_MS` (`network/src/lib.rs`). */
export const NPM_FETCH_TIMEOUT_MS = 60_000;

export const NPM_BEARER = {
	key: 'bearer',
	scheme: 'bearer',
	type: 'http',
} as const satisfies Auth;

function http11Fetch(input: Request | URL | string, init?: RequestInit): Promise<Response> {
	return fetch(input, { ...init, protocol: 'http1.1' });
}

export function npmRegistryBaseUrl(registry: string): string {
	const url = new URL(trailingSlash(registry));
	return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

export function npmRegistryClient(registry: string, token?: string): Client {
	const baseUrl = npmRegistryBaseUrl(registry);
	const shared = {
		baseUrl,
		throwOnError: false,
		retry: 0,
		timeout: NPM_FETCH_TIMEOUT_MS,
		headers: { 'User-Agent': `${name}/${version}` },
		kyOptions: { fetch: http11Fetch },
	} as const;
	return createClient(
		match(token)
			.with(P.string.minLength(1), (authToken) =>
				createConfig({ ...shared, auth: () => authToken }),
			)
			.otherwise(() => createConfig(shared)),
	);
}
