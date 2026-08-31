import { afterEach, describe, expect, test } from 'bun:test';
import {
	NPM_REGISTRY,
	publishRetry,
	registryHasVersion,
	waitForRegistryVersion,
} from 'bun-release';
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

describe('registryHasVersion', () => {
	test('is false on 404', async () => {
		installFetch(async () => new Response('{"error":"Not found"}', { status: 404 }));
		expect(await registryHasVersion('bun-release', '0.0.0')).toBe(false);
	});

	test('is true when the packument lists the version', async () => {
		installFetch(async (url) => {
			expect(url).toBe(`${NPM_REGISTRY}bun-release`);
			return Response.json({ versions: { '0.0.0': {} } });
		});
		expect(await registryHasVersion('bun-release', '0.0.0')).toBe(true);
	});

	test('encodes a scoped name in the packument URL', async () => {
		const urls: string[] = [];
		installFetch(async (url) => {
			urls.push(url);
			return Response.json({ versions: { '0.0.1': {} } });
		});
		expect(await registryHasVersion('@victor-software-house/anti-slop', '0.0.1')).toBe(true);
		expect(urls[0]).toBe(`${NPM_REGISTRY}@victor-software-house%2fanti-slop`);
	});

	test('sends Authorization when a token is given', async () => {
		const headers: string[] = [];
		const stub = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const request = input instanceof Request ? input : new Request(input.toString(), init);
				headers.push(request.headers.get('authorization') ?? '');
				return Response.json({ versions: { '0.0.0': {} } });
			},
			{ preconnect: () => undefined },
		);
		globalThis.fetch = stub;
		expect(await registryHasVersion('bun-release', '0.0.0', NPM_REGISTRY, 'session')).toBe(true);
		expect(headers[0]).toBe('Bearer session');
	});
});

describe('waitForRegistryVersion', () => {
	const fast = { ...publishRetry, retries: 2, minTimeout: 1, maxRetryTime: 500 };

	test('returns once the packument lists the version', async () => {
		let calls = 0;
		installFetch(async () => {
			calls += 1;
			return match(calls)
				.with(1, () => new Response('{"error":"Not found"}', { status: 404 }))
				.otherwise(() => Response.json({ versions: { '0.0.1': {} } }));
		});
		await waitForRegistryVersion('bun-release', '0.0.1', NPM_REGISTRY, fast);
		expect(calls).toBe(2);
	});

	test('throws when the version never appears', async () => {
		installFetch(async () => new Response('{"error":"Not found"}', { status: 404 }));
		let message = '';
		try {
			await waitForRegistryVersion('bun-release', '0.0.1', NPM_REGISTRY, {
				...publishRetry,
				retries: 0,
				minTimeout: 1,
				maxRetryTime: 100,
			});
		} catch (error) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message).toBe('npm registry did not observe bun-release@0.0.1');
	});
});
