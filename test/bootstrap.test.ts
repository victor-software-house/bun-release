import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdout } from 'node:process';
import { bootstrapNpmPackages, bootstrapVisibilityRetry, loginRetry } from 'bun-release';
import { match, P } from 'ts-pattern';

const SESSION = 'test-bootstrap-session';
const OTP = 'test-bootstrap-otp';
const fastVisibility = {
	...bootstrapVisibilityRetry,
	retries: 8,
	minTimeout: 1,
	maxRetryTime: 2_000,
};
const fastLogin = { ...loginRetry, retries: 8, minTimeout: 1, maxRetryTime: 2_000 };

type PublishRecord = {
	name: string;
	version: string;
	hadAuth: boolean;
	hadOtp: boolean;
};

type TrustCall = {
	name: string;
	method: string;
	hadAuth: boolean;
	hadOtp: boolean;
	otp: string | null;
};

type FakeRegistry = {
	url: string;
	published: Map<string, Set<string>>;
	events: string[];
	trust: Map<string, unknown[]>;
	publishes: PublishRecord[];
	trustPosts: string[];
	trustCalls: TrustCall[];
	loginBodies: unknown[];
	loginAuthType: string[];
	stop: () => void;
};

type OtpChallengeBody = 'nested' | 'plain' | 'loginUrl';

function otpChallengeResponse(origin: string, sessionId: string, kind: OtpChallengeBody): Response {
	const nested = {
		error: 'one-time pass',
		authUrl: `${origin}/otp-ui`,
		doneUrl: `${origin}/-/v1/done?sessionId=${sessionId}`,
	};
	const body = match(kind)
		.with('plain', () => ({ error: 'one-time pass', code: 'EOTP' }))
		.with('loginUrl', () => ({
			error: 'one-time pass',
			loginUrl: `${origin}/otp-ui`,
			doneUrl: `${origin}/-/v1/done?sessionId=${sessionId}`,
			extra: true,
		}))
		.with('nested', () => nested)
		.exhaustive();
	return Response.json(body, {
		status: 401,
		headers: { 'www-authenticate': 'OTP' },
	});
}

function startFakeRegistry(options?: {
	loginError?: { status: number; body: string };
	pendingPolls?: number;
	pendingStatus?: 202 | 404;
	requireOtp?: boolean;
	requireTrustOtp?: boolean;
	consumeTrustOtp?: boolean;
	putOtpBody?: OtpChallengeBody;
	createOtpBody?: OtpChallengeBody;
	putError?: { status: number; body: string };
	visibilityPollsAfterPut?: number;
	acceptPutWithoutOtpAfterSpentOtp?: boolean;
	trustRateLimits?: number;
	rateLimitTrustOtp?: boolean;
}): FakeRegistry {
	const published = new Map<string, Set<string>>();
	const events: string[] = [];
	const visibilityPolls = new Map<string, number>();
	const trust = new Map<string, unknown[]>();
	const publishes: PublishRecord[] = [];
	const trustPosts: string[] = [];
	const trustCalls: TrustCall[] = [];
	const loginBodies: unknown[] = [];
	const loginAuthType: string[] = [];
	const usedTrustOtps = new Set<string>();
	const usedPutOtps = new Set<string>();
	let acceptNextPutWithoutOtp = false;
	let trustOtpChallenges = 0;
	let trustRateLimits = options?.trustRateLimits ?? 0;
	let remainingPolls = options?.pendingPolls ?? 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const path = decodeURIComponent(url.pathname);
			const trustName = /^\/-\/package\/(?<name>.+)\/trust$/.exec(path)?.groups?.['name'];
			const packumentName = /^\/(?<name>.+)$/.exec(path)?.groups?.['name'];
			return match({ method: request.method, path, trustName, packumentName })
				.with({ method: 'POST', path: '/-/v1/login' }, async () => {
					loginBodies.push(await request.json());
					loginAuthType.push(request.headers.get('npm-auth-type') ?? '');
					return match(options?.loginError)
						.with(P.nonNullable, ({ status, body }) => new Response(body, { status }))
						.otherwise(() =>
							Response.json({
								loginUrl: `${url.origin}/login-ui`,
								doneUrl: `${url.origin}/-/v1/login/done`,
							}),
						);
				})
				.with({ method: 'GET', path: '/-/v1/login/done' }, () =>
					match(remainingPolls > 0)
						.with(true, () => {
							remainingPolls -= 1;
							return match(options?.pendingStatus)
								.with(404, () => new Response('not found', { status: 404 }))
								.otherwise(
									() =>
										new Response(null, {
											status: 202,
											headers: { 'retry-after': '0' },
										}),
								);
						})
						.with(false, () => Response.json({ token: SESSION }))
						.exhaustive(),
				)
				.with({ method: 'GET', path: '/-/v1/done' }, () =>
					match(url.searchParams.get('sessionId'))
						.with(P.string.minLength(1), (sessionId) => Response.json({ token: sessionId }))
						.otherwise(() => new Response('not found', { status: 404 })),
				)
				.with({ method: 'PUT', packumentName: P.string }, (route) =>
					handlePut(route.packumentName, request, url.origin),
				)
				.with({ method: P.union('GET', 'POST'), trustName: P.string }, (route) =>
					handleTrust(route.method, route.trustName, request),
				)
				.with({ method: 'GET', packumentName: P.string }, (route) =>
					packumentResponse(route.packumentName),
				)
				.otherwise(() => new Response('not found', { status: 404 }));
		},
	});

	async function handlePut(name: string, request: Request, origin: string): Promise<Response> {
		return match(options?.putError)
			.with(P.nonNullable, ({ status, body }) => new Response(body, { status }))
			.otherwise(async () => {
				const payload: unknown = await request.json();
				const version = match(payload)
					.with({ 'dist-tags': { latest: P.string } }, (body) => body['dist-tags'].latest)
					.otherwise(() => '');
				const expectedOtp = options?.putOtpBody === 'plain' ? SESSION : OTP;
				const otpHeader = request.headers.get('npm-otp');
				const spentOtp =
					options?.acceptPutWithoutOtpAfterSpentOtp === true &&
					otpHeader !== null &&
					usedPutOtps.has(otpHeader);
				if (spentOtp) {
					acceptNextPutWithoutOtp = true;
					return otpChallengeResponse(origin, OTP, 'plain');
				}
				const hadOtp = otpHeader === expectedOtp;
				const needsOtp =
					options?.requireOtp === true &&
					!hadOtp &&
					!(acceptNextPutWithoutOtp && otpHeader === null);
				return match({ requireOtp: options?.requireOtp === true, hadOtp })
					.when(
						() => needsOtp,
						() => otpChallengeResponse(origin, OTP, options?.putOtpBody ?? 'nested'),
					)
					.otherwise(() => {
						acceptNextPutWithoutOtp = false;
						if (otpHeader !== null) {
							usedPutOtps.add(otpHeader);
						}
						events.push(`PUT ${name}`);
						publishes.push({
							name,
							version,
							hadAuth: request.headers.get('authorization') === `Bearer ${SESSION}`,
							hadOtp,
						});
						const versions = published.get(name) ?? new Set<string>();
						versions.add(version);
						published.set(name, versions);
						visibilityPolls.set(name, options?.visibilityPollsAfterPut ?? 0);
						return new Response(null, { status: 201 });
					});
			});
	}

	function trustOtpChallenge(
		request: Request,
		sessionId: string,
		kind: OtpChallengeBody,
	): Response {
		return otpChallengeResponse(new URL(request.url).origin, sessionId, kind);
	}

	async function handleTrust(method: string, name: string, request: Request): Promise<Response> {
		const otpHeader = request.headers.get('npm-otp');
		if (options?.rateLimitTrustOtp === true && otpHeader !== null) {
			trustCalls.push({ name, method, hadAuth: true, hadOtp: true, otp: otpHeader });
			return new Response(null, { status: 429, headers: { 'retry-after': '0.001' } });
		}
		if (trustRateLimits > 0) {
			trustRateLimits -= 1;
			return new Response(null, { status: 429, headers: { 'retry-after': '0.001' } });
		}
		const consume = options?.consumeTrustOtp === true;
		const hadOtp = consume ? Boolean(otpHeader) : otpHeader === OTP;
		const hadAuth = request.headers.get('authorization') === `Bearer ${SESSION}`;
		trustCalls.push({ name, method, hadAuth, hadOtp, otp: otpHeader });
		const reused = consume && otpHeader !== null && usedTrustOtps.has(otpHeader);
		const needsChallenge =
			(options?.requireTrustOtp === true && !hadOtp) ||
			(consume && (otpHeader === null || otpHeader === '' || reused));
		return match(needsChallenge)
			.with(true, () => {
				trustOtpChallenges += 1;
				const sessionId = consume ? `${OTP}-${trustOtpChallenges}` : OTP;
				const kind: OtpChallengeBody = match({ consume, method, hadOtp })
					.with(
						{ consume: true, method: 'POST', hadOtp: true },
						() => options?.createOtpBody ?? 'nested',
					)
					.otherwise(() => 'nested');
				return trustOtpChallenge(request, sessionId, kind);
			})
			.with(false, () => {
				match({ consume, method, otpHeader })
					.with(
						{ consume: true, method: 'GET', otpHeader: P.string.minLength(1) },
						({ otpHeader: accepted }) => {
							usedTrustOtps.add(accepted);
						},
					)
					.otherwise(() => undefined);
				return match(method)
					.with('GET', () => Response.json(trust.get(name) ?? []))
					.with('POST', async () => {
						trustPosts.push(name);
						const body: unknown = await request.json();
						const current = trust.get(name) ?? [];
						trust.set(name, current.concat(Array.isArray(body) ? body : [body]));
						return Response.json(trust.get(name) ?? []);
					})
					.otherwise(() => new Response('not found', { status: 404 }));
			})
			.exhaustive();
	}

	function packumentResponse(name: string): Response {
		const remaining = visibilityPolls.get(name) ?? 0;
		if (remaining > 0) {
			visibilityPolls.set(name, remaining - 1);
			return new Response('{"error":"Not found"}', { status: 404 });
		}
		return match(published.get(name))
			.with(P.instanceOf(Set), (versions) => {
				events.push(`VISIBLE ${name}`);
				return Response.json({
					versions: Object.fromEntries([...versions].map((version) => [version, {}])),
				});
			})
			.otherwise(() => new Response('{"error":"Not found"}', { status: 404 }));
	}
	return {
		url: `http://127.0.0.1:${server.port}/`,
		published,
		events,
		trust,
		publishes,
		trustPosts,
		trustCalls,
		loginBodies,
		loginAuthType,
		stop: () => {
			void server.stop(true);
		},
	};
}

function captureStdout() {
	const chunks: string[] = [];
	const original = stdout.write.bind(stdout);
	stdout.write = (chunk) => {
		chunks.push(Buffer.from(chunk).toString());
		return original(chunk);
	};
	return {
		text: () => chunks.join(''),
		restore: () => {
			stdout.write = original;
		},
	};
}

function stagedPackage(root: string, name: string, version: string): string {
	const directory = join(root, name.replace('/', '__'));
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version }));
	return directory;
}

let registry: FakeRegistry | undefined;

afterEach(() => {
	registry?.stop();
	registry = undefined;
});

describe('bootstrapNpmPackages', () => {
	test('does not replay a one-time password after a trust rate limit', async () => {
		registry = startFakeRegistry({ requireTrustOtp: true, rateLimitTrustOtp: true });
		const name = '@victor-software-house/bootstrap-trust-otp-rate-limit';
		registry.published.set(name, new Set(['0.0.0']));
		const root = join(tmpdir(), `bun-release-bootstrap-trust-otp-rate-limit-${Date.now()}`);
		let message = '';
		try {
			await bootstrapNpmPackages(
				[{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }],
				'victor-software-house/exa-cli',
				'release.yml',
				{
					registry: registry.url,
					visibilityRetry: fastVisibility,
					loginRetry: fastLogin,
					openUrl: async () => undefined,
				},
			);
		} catch (error) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message).toContain('npm trust list failed');
		expect(registry.trustCalls).toHaveLength(2);
	}, 15_000);

	test('retries npm trust rate limits beyond the default ky budget', async () => {
		registry = startFakeRegistry({ trustRateLimits: 6 });
		const name = '@victor-software-house/bootstrap-trust-rate-limit';
		registry.published.set(name, new Set(['0.0.0']));
		registry.trust.set(name, [
			{
				type: 'github',
				claims: {
					repository: 'victor-software-house/exa-cli',
					workflow_ref: { file: 'release.yml' },
				},
				permissions: ['createPackage'],
			},
		]);
		const root = join(tmpdir(), `bun-release-bootstrap-trust-rate-limit-${Date.now()}`);
		await bootstrapNpmPackages(
			[{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }],
			'victor-software-house/exa-cli',
			'release.yml',
			{
				registry: registry.url,
				visibilityRetry: fastVisibility,
				loginRetry: fastLogin,
				openUrl: async () => undefined,
			},
		);
		expect(registry.trustPosts).toEqual([]);
	}, 10_000);

	test('publishes the next package while earlier visibility is pending', async () => {
		registry = startFakeRegistry({ visibilityPollsAfterPut: 3 });
		const first = '@victor-software-house/bootstrap-pipeline-one';
		const second = '@victor-software-house/bootstrap-pipeline-two';
		const root = join(tmpdir(), `bun-release-bootstrap-pipeline-${Date.now()}`);
		await bootstrapNpmPackages(
			[
				{ name: first, version: '0.0.0', directory: stagedPackage(root, first, '0.0.0') },
				{ name: second, version: '0.0.0', directory: stagedPackage(root, second, '0.0.0') },
			],
			'victor-software-house/exa-cli',
			'release.yml',
			{
				registry: registry.url,
				visibilityRetry: fastVisibility,
				loginRetry: fastLogin,
				openUrl: async () => undefined,
			},
		);
		expect(registry.events.indexOf(`PUT ${second}`)).toBeLessThan(
			registry.events.indexOf(`VISIBLE ${first}`),
		);
	});

	test('waits for every visibility check and fails before trust', async () => {
		registry = startFakeRegistry({ visibilityPollsAfterPut: 100 });
		const first = '@victor-software-house/bootstrap-invisible-one';
		const second = '@victor-software-house/bootstrap-invisible-two';
		const root = join(tmpdir(), `bun-release-bootstrap-invisible-${Date.now()}`);
		const result = bootstrapNpmPackages(
			[
				{ name: first, version: '0.0.0', directory: stagedPackage(root, first, '0.0.0') },
				{ name: second, version: '0.0.0', directory: stagedPackage(root, second, '0.0.0') },
			],
			'victor-software-house/exa-cli',
			'release.yml',
			{
				registry: registry.url,
				visibilityRetry: {
					...fastVisibility,
					retries: 1,
					maxRetryTime: 100,
				},
				loginRetry: fastLogin,
				openUrl: async () => undefined,
			},
		);
		let message = '';
		try {
			await result;
		} catch (error) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message).toContain('npm registry did not expose');
		expect(registry.publishes.map((row) => row.name)).toEqual([first, second]);
		expect(registry.trustCalls).toEqual([]);
	});

	test('publishes missing packages in order and skips existing', async () => {
		registry = startFakeRegistry({ pendingPolls: 1 });
		const first = '@victor-software-house/bootstrap-one';
		const second = '@victor-software-house/bootstrap-two';
		registry.published.set(second, new Set(['0.0.0']));
		registry.trust.set(second, [
			{
				type: 'github',
				claims: {
					repository: 'victor-software-house/exa-cli',
					workflow_ref: { file: 'release.yml' },
				},
				permissions: ['createPackage'],
			},
		]);
		const root = join(tmpdir(), `bun-release-bootstrap-test-${Date.now()}`);
		const packages = [
			{ name: first, version: '0.0.0', directory: stagedPackage(root, first, '0.0.0') },
			{ name: second, version: '0.0.0', directory: stagedPackage(root, second, '0.0.0') },
		];
		const captured = captureStdout();
		await bootstrapNpmPackages(packages, 'victor-software-house/exa-cli', 'release.yml', {
			registry: registry.url,
			visibilityRetry: fastVisibility,
			loginRetry: fastLogin,
			openUrl: async () => undefined,
		});
		captured.restore();
		expect(registry.publishes.map((row) => row.name)).toEqual([first]);
		expect(registry.publishes[0]?.hadAuth).toBe(true);
		expect(registry.publishes[0]?.hadOtp).toBe(false);
		expect(registry.trustPosts).toEqual([first]);
		expect(captured.text()).not.toContain(SESSION);
		expect(captured.text()).toContain(`bootstrapped ${first}@0.0.0`);
		expect(captured.text()).toContain(`[prepare ${second}] already published`);
		expect(registry.loginAuthType).toEqual(['web']);
		expect(
			match(registry.loginBodies)
				.with([{ hostname: P.string.minLength(1) }], () => true)
				.otherwise(() => false),
		).toBe(true);
	});

	test('completes web otp from a 401 and retries the same PUT', async () => {
		registry = startFakeRegistry({ requireOtp: true });
		const name = '@victor-software-house/bootstrap-otp';
		const root = join(tmpdir(), `bun-release-bootstrap-otp-${Date.now()}`);
		const opened: string[] = [];
		await bootstrapNpmPackages(
			[{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }],
			'victor-software-house/exa-cli',
			'release.yml',
			{
				registry: registry.url,
				visibilityRetry: fastVisibility,
				loginRetry: fastLogin,
				openUrl: async (url) => {
					opened.push(url);
				},
			},
		);
		expect(opened).toEqual([`${registry.url}login-ui`, `${registry.url}otp-ui`]);
		expect(registry.publishes).toEqual([{ name, version: '0.0.0', hadAuth: true, hadOtp: true }]);
		expect(registry.trustCalls.filter((row) => row.hadOtp).map((row) => row.method)).toEqual([
			'GET',
			'POST',
		]);
	});

	test('accepts a successful retry without a spent npm otp', async () => {
		registry = startFakeRegistry({
			requireOtp: true,
			acceptPutWithoutOtpAfterSpentOtp: true,
		});
		const first = '@victor-software-house/bootstrap-spent-otp-one';
		const second = '@victor-software-house/bootstrap-spent-otp-two';
		const root = join(tmpdir(), `bun-release-bootstrap-spent-otp-${Date.now()}`);
		await bootstrapNpmPackages(
			[
				{ name: first, version: '0.0.0', directory: stagedPackage(root, first, '0.0.0') },
				{ name: second, version: '0.0.0', directory: stagedPackage(root, second, '0.0.0') },
			],
			'victor-software-house/exa-cli',
			'release.yml',
			{
				registry: registry.url,
				visibilityRetry: fastVisibility,
				loginRetry: fastLogin,
				openUrl: async () => undefined,
			},
		);
		expect(registry.publishes.map((row) => row.name)).toEqual([first, second]);
	});

	test('completes web otp for trust create after skip publish when list otp is spent', async () => {
		registry = startFakeRegistry({ consumeTrustOtp: true });
		const name = '@victor-software-house/bootstrap-trust-create-otp';
		registry.published.set(name, new Set(['0.0.0']));
		const root = join(tmpdir(), `bun-release-bootstrap-trust-create-otp-${Date.now()}`);
		const opened: string[] = [];
		await bootstrapNpmPackages(
			[{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }],
			'victor-software-house/exa-cli',
			'release.yml',
			{
				registry: registry.url,
				visibilityRetry: fastVisibility,
				loginRetry: fastLogin,
				openUrl: async (url) => {
					opened.push(url);
				},
			},
		);
		expect(opened).toEqual([
			`${registry.url}login-ui`,
			`${registry.url}otp-ui`,
			`${registry.url}otp-ui`,
		]);
		expect(registry.publishes).toEqual([]);
		expect(registry.trustPosts).toEqual([name]);
		expect(registry.trustCalls.map((row) => ({ method: row.method, hadOtp: row.hadOtp }))).toEqual([
			{ method: 'GET', hadOtp: false },
			{ method: 'GET', hadOtp: true },
			{ method: 'POST', hadOtp: true },
			{ method: 'POST', hadOtp: true },
		]);
		const listOtp = registry.trustCalls[1]?.otp;
		const spentCreate = registry.trustCalls[2]?.otp;
		const createOtp = registry.trustCalls[3]?.otp;
		expect(listOtp).toBe(`${OTP}-1`);
		expect(spentCreate).toBe(listOtp);
		expect(createOtp).toBe(`${OTP}-2`);
		expect(createOtp).not.toBe(listOtp);
	});

	test('retries trust create without npm-otp when 401 has no challenge URLs', async () => {
		registry = startFakeRegistry({ consumeTrustOtp: true, createOtpBody: 'plain' });
		const name = '@victor-software-house/bootstrap-trust-create-plain-otp';
		registry.published.set(name, new Set(['0.0.0']));
		const root = join(tmpdir(), `bun-release-bootstrap-trust-create-plain-${Date.now()}`);
		const opened: string[] = [];
		await bootstrapNpmPackages(
			[{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }],
			'victor-software-house/exa-cli',
			'release.yml',
			{
				registry: registry.url,
				visibilityRetry: fastVisibility,
				loginRetry: fastLogin,
				openUrl: async (url) => {
					opened.push(url);
				},
			},
		);
		expect(opened).toEqual([
			`${registry.url}login-ui`,
			`${registry.url}otp-ui`,
			`${registry.url}otp-ui`,
		]);
		expect(registry.loginBodies).toHaveLength(1);
		expect(registry.trustPosts).toEqual([name]);
		expect(registry.trustCalls.map((row) => ({ method: row.method, hadOtp: row.hadOtp }))).toEqual([
			{ method: 'GET', hadOtp: false },
			{ method: 'GET', hadOtp: true },
			{ method: 'POST', hadOtp: true },
			{ method: 'POST', hadOtp: false },
			{ method: 'POST', hadOtp: true },
		]);
		expect(registry.trustCalls[1]?.otp).toBe(`${OTP}-1`);
		expect(registry.trustCalls[2]?.otp).toBe(`${OTP}-1`);
		expect(registry.trustCalls[4]?.otp).toBe(`${OTP}-3`);
	});

	test('uses loginUrl/doneUrl on a trust create 401 when authUrl is absent', async () => {
		registry = startFakeRegistry({ consumeTrustOtp: true, createOtpBody: 'loginUrl' });
		const name = '@victor-software-house/bootstrap-trust-create-loginurl';
		registry.published.set(name, new Set(['0.0.0']));
		const root = join(tmpdir(), `bun-release-bootstrap-trust-create-loginurl-${Date.now()}`);
		const opened: string[] = [];
		await bootstrapNpmPackages(
			[{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }],
			'victor-software-house/exa-cli',
			'release.yml',
			{
				registry: registry.url,
				visibilityRetry: fastVisibility,
				loginRetry: fastLogin,
				openUrl: async (url) => {
					opened.push(url);
				},
			},
		);
		expect(opened).toEqual([
			`${registry.url}login-ui`,
			`${registry.url}otp-ui`,
			`${registry.url}otp-ui`,
		]);
		expect(registry.trustCalls[3]?.otp).toBe(`${OTP}-2`);
	});

	test('fails publish when 401 is otp without challenge URLs', async () => {
		registry = startFakeRegistry({ requireOtp: true, putOtpBody: 'plain' });
		const name = '@victor-software-house/bootstrap-put-plain-otp';
		const root = join(tmpdir(), `bun-release-bootstrap-put-plain-${Date.now()}`);
		expect(
			bootstrapNpmPackages(
				[{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }],
				'victor-software-house/exa-cli',
				'release.yml',
				{
					registry: registry.url,
					visibilityRetry: fastVisibility,
					loginRetry: fastLogin,
					openUrl: async () => undefined,
				},
			),
		).rejects.toThrow('npm publish needs otp without authUrl/doneUrl');
	});

	test('completes web otp for trust list after skip publish', async () => {
		registry = startFakeRegistry({ requireTrustOtp: true });
		const name = '@victor-software-house/bootstrap-trust-otp';
		registry.published.set(name, new Set(['0.0.0']));
		const root = join(tmpdir(), `bun-release-bootstrap-trust-otp-${Date.now()}`);
		const opened: string[] = [];
		await bootstrapNpmPackages(
			[{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }],
			'victor-software-house/exa-cli',
			'release.yml',
			{
				registry: registry.url,
				visibilityRetry: fastVisibility,
				loginRetry: fastLogin,
				openUrl: async (url) => {
					opened.push(url);
				},
			},
		);
		expect(opened).toEqual([`${registry.url}login-ui`, `${registry.url}otp-ui`]);
		expect(registry.publishes).toEqual([]);
		expect(registry.trustPosts).toEqual([name]);
		expect(registry.trustCalls.map((row) => ({ method: row.method, hadOtp: row.hadOtp }))).toEqual([
			{ method: 'GET', hadOtp: false },
			{ method: 'GET', hadOtp: true },
			{ method: 'POST', hadOtp: true },
		]);
	});

	test('keeps polling after 404 until the token', async () => {
		registry = startFakeRegistry({ pendingPolls: 2, pendingStatus: 404 });
		const name = '@victor-software-house/bootstrap-poll-404';
		const root = join(tmpdir(), `bun-release-bootstrap-404-${Date.now()}`);
		await bootstrapNpmPackages(
			[{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }],
			'victor-software-house/exa-cli',
			'release.yml',
			{
				registry: registry.url,
				visibilityRetry: fastVisibility,
				loginRetry: fastLogin,
				openUrl: async () => undefined,
			},
		);
		expect(registry.publishes).toEqual([{ name, version: '0.0.0', hadAuth: true, hadOtp: false }]);
	});

	test('surfaces a registry PUT error', async () => {
		registry = startFakeRegistry({
			putError: { status: 500, body: 'registry down' },
		});
		const name = '@victor-software-house/bootstrap-fail';
		const root = join(tmpdir(), `bun-release-fixture-fail-${Date.now()}`);
		let message = '';
		try {
			await bootstrapNpmPackages(
				[{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }],
				'victor-software-house/exa-cli',
				'release.yml',
				{
					registry: registry.url,
					visibilityRetry: fastVisibility,
					loginRetry: fastLogin,
					openUrl: async () => undefined,
				},
			);
		} catch (error) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message).toContain('npm publish failed for');
		expect(message).toContain('registry down');
	});

	test('includes the registry error when web login is rejected', async () => {
		registry = startFakeRegistry({
			loginError: {
				status: 401,
				body: '{"error":"You must be logged in to publish packages."}',
			},
		});
		const root = join(tmpdir(), `bun-release-bootstrap-login-${Date.now()}`);
		let message = '';
		try {
			await bootstrapNpmPackages(
				[
					{
						name: '@victor-software-house/bootstrap-login',
						version: '0.0.0',
						directory: stagedPackage(root, '@victor-software-house/bootstrap-login', '0.0.0'),
					},
				],
				'victor-software-house/exa-cli',
				'release.yml',
				{
					registry: registry.url,
					loginRetry: fastLogin,
					openUrl: async () => undefined,
				},
			);
		} catch (error) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message).toContain('npm web login failed (401)');
		expect(message).toContain('You must be logged in to publish packages.');
	});
});
