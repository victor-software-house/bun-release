import { afterEach, describe, expect, test } from 'bun:test';
import { loginRetry, pollWebToken } from 'bun-release';
import { match } from 'ts-pattern';

const TOKEN = 'web-auth-token';
const fastLogin = { ...loginRetry, retries: 8, minTimeout: 1, maxRetryTime: 2_000 };

type PollHandler = (request: Request) => Response | Promise<Response>;

let stop: (() => void) | undefined;

afterEach(() => {
	stop?.();
	stop = undefined;
});

function startPollServer(handler: PollHandler): string {
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: handler,
	});
	stop = () => {
		void server.stop(true);
	};
	return `http://127.0.0.1:${server.port}`;
}

function pollUrl(origin: string, path = '/-/v1/login/done'): string {
	return `${origin}${path}`;
}

describe('pollWebToken', () => {
	test('returns a token on the first 200', async () => {
		const origin = startPollServer(() => Response.json({ token: TOKEN }));
		expect(await pollWebToken(pollUrl(origin), fastLogin)).toBe(TOKEN);
	});

	test('GETs the opaque doneUrl path and query', async () => {
		const seen: string[] = [];
		const origin = startPollServer((request) => {
			const url = new URL(request.url);
			seen.push(`${url.pathname}${url.search}`);
			return match(`${url.pathname}${url.search}`)
				.with('/auth/cli/done?sessionId=abc', () => Response.json({ token: TOKEN }))
				.otherwise(() => new Response('not found', { status: 404 }));
		});
		expect(await pollWebToken(`${origin}/auth/cli/done?sessionId=abc`, fastLogin)).toBe(TOKEN);
		expect(seen).toEqual(['/auth/cli/done?sessionId=abc']);
	});

	test('keeps polling after 404 until the token', async () => {
		let remaining = 2;
		const origin = startPollServer(() =>
			match(remaining-- > 0)
				.with(true, () => new Response('not found', { status: 404 }))
				.otherwise(() => Response.json({ token: TOKEN })),
		);
		expect(await pollWebToken(pollUrl(origin), fastLogin)).toBe(TOKEN);
	});

	test('keeps polling after empty 200 until the token', async () => {
		let remaining = 2;
		const origin = startPollServer(() =>
			match(remaining-- > 0)
				.with(true, () => Response.json({ token: '' }))
				.otherwise(() => Response.json({ token: TOKEN })),
		);
		expect(await pollWebToken(pollUrl(origin), fastLogin)).toBe(TOKEN);
	});

	test('honors 202 Retry-After then returns the token', async () => {
		let remaining = 1;
		const origin = startPollServer(() =>
			match(remaining-- > 0)
				.with(true, () => new Response(null, { status: 202, headers: { 'retry-after': '0.05' } }))
				.otherwise(() => Response.json({ token: TOKEN })),
		);
		const started = performance.now();
		expect(await pollWebToken(pollUrl(origin), fastLogin)).toBe(TOKEN);
		expect(performance.now() - started).toBeGreaterThanOrEqual(40);
	});

	test('202 without Retry-After uses the poll interval', async () => {
		let remaining = 1;
		const origin = startPollServer(() =>
			match(remaining-- > 0)
				.with(true, () => new Response(null, { status: 202 }))
				.otherwise(() => Response.json({ token: TOKEN })),
		);
		expect(await pollWebToken(pollUrl(origin), fastLogin)).toBe(TOKEN);
	});

	test('non-numeric Retry-After uses the poll interval', async () => {
		let remaining = 1;
		const origin = startPollServer(() =>
			match(remaining-- > 0)
				.with(true, () => new Response(null, { status: 202, headers: { 'retry-after': 'soon' } }))
				.otherwise(() => Response.json({ token: TOKEN })),
		);
		expect(await pollWebToken(pollUrl(origin), fastLogin)).toBe(TOKEN);
	});

	test('202 then 404 then token', async () => {
		let step = 0;
		const origin = startPollServer(() =>
			match(step++)
				.with(0, () => new Response(null, { status: 202, headers: { 'retry-after': '0' } }))
				.with(1, () => new Response('not found', { status: 404 }))
				.otherwise(() => Response.json({ token: TOKEN })),
		);
		expect(await pollWebToken(pollUrl(origin), fastLogin)).toBe(TOKEN);
	});

	test('throws when retries are exhausted', async () => {
		const origin = startPollServer(() => new Response('not found', { status: 404 }));
		expect(pollWebToken(pollUrl(origin), { ...fastLogin, retries: 2 })).rejects.toThrow(
			'npm web auth pending',
		);
	});

	test('throws when the budget elapses', async () => {
		const origin = startPollServer(() => new Response('not found', { status: 404 }));
		expect(
			pollWebToken(pollUrl(origin), {
				...fastLogin,
				retries: 50,
				minTimeout: 40,
				maxRetryTime: 60,
			}),
		).rejects.toThrow('npm web auth timed out');
	});
});
