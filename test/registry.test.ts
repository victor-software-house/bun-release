import { afterEach, describe, expect, test } from 'bun:test';
import { NPM_REGISTRY, registryHasVersion } from 'bun-release';
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
			return new Response(JSON.stringify({ versions: { '0.0.0': {} } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		expect(await registryHasVersion('bun-release', '0.0.0')).toBe(true);
	});

	test('encodes a scoped name in the packument URL', async () => {
		installFetch(async (url) => {
			expect(url).toBe(`${NPM_REGISTRY}@victor-software-house%2Fanti-slop`);
			return new Response(JSON.stringify({ versions: { '0.0.1': {} } }), { status: 200 });
		});
		expect(await registryHasVersion('@victor-software-house/anti-slop', '0.0.1')).toBe(true);
	});
});
