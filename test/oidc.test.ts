import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmOidcPublishToken, writeMaskedGithubEnv } from 'bun-release';
import { match, P } from 'ts-pattern';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function requestUrl(input: string | URL | Request): string {
	return match(input)
		.with(P.string, (url) => url)
		.with(P.instanceOf(URL), (url) => url.href)
		.with(P.instanceOf(Request), (request) => request.url)
		.exhaustive();
}

function installFetch(handler: (url: string) => Promise<Response>): void {
	const stub = Object.assign(async (input: string | URL | Request) => handler(requestUrl(input)), {
		preconnect: () => undefined,
	});
	globalThis.fetch = stub;
}

describe('npmOidcPublishToken', () => {
	test('throws when the GitHub OIDC env is empty', async () => {
		let message = '';
		try {
			await npmOidcPublishToken('bun-release', {});
		} catch (error) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message).toBe(
			'OIDC publish needs ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN',
		);
	});

	test('exchanges the GitHub id-token for an npm publish token', async () => {
		const calls: string[] = [];
		installFetch(async (url) => {
			calls.push(url);
			return match(url)
				.when(
					(value) => value.includes('audience='),
					() => Response.json({ value: 'github-id-token' }),
				)
				.when(
					(value) => value.includes('/-/npm/v1/oidc/token/exchange/package/'),
					() => Response.json({ token: 'npm-publish-token' }),
				)
				.otherwise(() => new Response('not found', { status: 404 }));
		});
		const token = await npmOidcPublishToken('bun-release', {
			ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/session',
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gha-token',
		});
		expect(token).toBe('npm-publish-token');
		expect(calls[1]).toContain('/-/npm/v1/oidc/token/exchange/package/bun-release');
	});

	test('encodes a scoped name without percent-encoding @', async () => {
		const calls: string[] = [];
		installFetch(async (url) => {
			calls.push(url);
			return match(url)
				.when(
					(value) => value.includes('audience='),
					() => Response.json({ value: 'github-id-token' }),
				)
				.otherwise(() => Response.json({ token: 'npm-publish-token' }));
		});
		await npmOidcPublishToken('@victor-software-house/exa-cli-darwin-arm64', {
			ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/session',
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gha-token',
		});
		expect(calls[1]).toContain(
			'/-/npm/v1/oidc/token/exchange/package/@victor-software-house%2fexa-cli-darwin-arm64',
		);
		expect(calls[1]).not.toContain('%40');
	});
});

describe('writeMaskedGithubEnv', () => {
	test('throws when the path is empty', async () => {
		let message = '';
		try {
			await writeMaskedGithubEnv('', 'token');
		} catch (error) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message).toBe('release:oidc writes BUN_CONFIG_TOKEN to GITHUB_ENV (CI only)');
	});

	test('appends BUN_CONFIG_TOKEN to the GitHub env file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'bun-release-env-'));
		const path = join(dir, 'github.env');
		await Bun.write(path, '');
		await writeMaskedGithubEnv(path, 'secret-token');
		expect(await Bun.file(path).text()).toBe('BUN_CONFIG_TOKEN=secret-token\n');
	});
});
