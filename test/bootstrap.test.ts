import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { env, stdout } from 'node:process';
import { bootstrapNpmPackages, loginRetry, publishRetry } from 'bun-release';
import dedent from 'dedent';
import { match, P } from 'ts-pattern';

const SESSION = 'test-bootstrap-session';
const fastPublish = { ...publishRetry, retries: 8, minTimeout: 1, maxRetryTime: 2_000 };
const fastLogin = { ...loginRetry, retries: 8, minTimeout: 1, maxRetryTime: 2_000 };

type PublishRecord = {
	name: string;
	version: string;
	cwd: string;
	home: string;
	hadAuth: boolean;
};

type FakeRegistry = {
	url: string;
	published: Map<string, Set<string>>;
	trust: Map<string, unknown[]>;
	publishes: PublishRecord[];
	trustPosts: string[];
	stop: () => void;
};

function startFakeRegistry(): FakeRegistry {
	const published = new Map<string, Set<string>>();
	const trust = new Map<string, unknown[]>();
	const publishes: PublishRecord[] = [];
	const trustPosts: string[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const path = decodeURIComponent(url.pathname);
			if (request.method === 'POST' && path === '/-/v1/login') {
				return Response.json({
					loginUrl: `${url.origin}/login-ui`,
					doneUrl: `${url.origin}/-/v1/login/done`,
				});
			}
			if (request.method === 'GET' && path === '/-/v1/login/done') {
				return Response.json({ token: SESSION });
			}
			if (request.method === 'POST' && path === '/_test/publish') {
				const body: unknown = await request.json();
				return match(body)
					.with(
						{
							name: P.string,
							version: P.string,
							cwd: P.string,
							home: P.string,
							hadAuth: P.boolean,
						},
						(row) => {
							publishes.push(row);
							const versions = published.get(row.name) ?? new Set<string>();
							versions.add(row.version);
							published.set(row.name, versions);
							return new Response(null, { status: 204 });
						},
					)
					.otherwise(() => new Response('bad publish', { status: 400 }));
			}
			const trustName = /^\/-\/package\/(?<name>.+)\/trust$/.exec(path)?.groups?.['name'];
			if (trustName !== undefined) {
				return handleTrust(request.method, trustName, request);
			}
			const packumentName = /^\/(?<name>.+)$/.exec(path)?.groups?.['name'];
			if (request.method === 'GET' && packumentName !== undefined) {
				return packumentResponse(packumentName);
			}
			return new Response('not found', { status: 404 });
		},
	});

	async function handleTrust(method: string, name: string, request: Request): Promise<Response> {
		if (method === 'GET') {
			return Response.json(trust.get(name) ?? []);
		}
		if (method !== 'POST') {
			return new Response('not found', { status: 404 });
		}
		trustPosts.push(name);
		const body: unknown = await request.json();
		const current = trust.get(name) ?? [];
		trust.set(name, current.concat(Array.isArray(body) ? body : [body]));
		return Response.json(trust.get(name) ?? []);
	}

	function packumentResponse(name: string): Response {
		const versions = published.get(name);
		if (versions === undefined) {
			return new Response('{"error":"Not found"}', { status: 404 });
		}
		return Response.json({
			versions: Object.fromEntries([...versions].map((version) => [version, {}])),
		});
	}
	return {
		url: `http://127.0.0.1:${server.port}/`,
		published,
		trust,
		publishes,
		trustPosts,
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

function writeFakeBun(
	binDir: string,
	registry: string,
	fail?: { name: string; homePath: string },
): void {
	const realBun = Bun.which('bun');
	if (realBun === null) {
		throw new Error('bun executable not found');
	}
	mkdirSync(binDir, { recursive: true });
	const failName = fail === undefined ? 'undefined' : JSON.stringify(fail.name);
	const failHome = fail === undefined ? 'undefined' : JSON.stringify(fail.homePath);
	writeFileSync(
		join(binDir, 'bun'),
		dedent`
			#!${realBun}
			const pkg = await Bun.file('package.json').json();
			const home = process.env.HOME ?? '';
			if (pkg.name === ${failName}) {
				await Bun.write(${failHome}, home);
				process.exit(1);
			}
			const npmrc = Bun.file(\`\${home}/.npmrc\`);
			const body = JSON.stringify({
				name: pkg.name,
				version: pkg.version,
				cwd: process.cwd(),
				home,
				hadAuth: (await npmrc.exists()) && (await npmrc.text()).includes('_authToken='),
			});
			const response = await fetch(${JSON.stringify(`${registry}_test/publish`)}, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			});
			if (!response.ok) {
				process.exit(1);
			}
		`,
		{ encoding: 'utf8' },
	);
	chmodSync(join(binDir, 'bun'), 0o755);
}

function stagedPackage(root: string, name: string, version: string): string {
	const directory = join(root, name.replace('/', '__'));
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version }));
	return directory;
}

const originalPath = env.PATH;
let registry: FakeRegistry | undefined;

afterEach(() => {
	registry?.stop();
	registry = undefined;
	env.PATH = originalPath ?? '';
});

describe('bootstrapNpmPackages', () => {
	test('publishes missing packages in order, skips existing, and isolates auth', async () => {
		registry = startFakeRegistry();
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
		const binDir = join(root, 'bin');
		writeFakeBun(binDir, registry.url);
		env.PATH = `${binDir}:${originalPath ?? ''}`;
		const firstDir = stagedPackage(root, first, '0.0.0');
		const packages = [
			{ name: first, version: '0.0.0', directory: firstDir },
			{ name: second, version: '0.0.0', directory: stagedPackage(root, second, '0.0.0') },
		];
		const captured = captureStdout();
		await bootstrapNpmPackages(packages, 'victor-software-house/exa-cli', 'release.yml', {
			registry: registry.url,
			publishRetry: fastPublish,
			loginRetry: fastLogin,
			openUrl: async () => undefined,
		});
		captured.restore();
		expect(registry.publishes.map((row) => row.name)).toEqual([first]);
		expect(realpathSync(registry.publishes[0]?.cwd ?? '')).toBe(realpathSync(firstDir));
		expect(registry.publishes[0]?.home).not.toBe(homedir());
		expect(registry.publishes[0]?.hadAuth).toBe(true);
		expect(existsSync(registry.publishes[0]?.home ?? '')).toBe(false);
		expect(registry.trustPosts).toEqual([first]);
		expect(captured.text()).not.toContain(SESSION);
		expect(captured.text()).toContain(`bootstrapped ${first}@0.0.0`);
		expect(captured.text()).toContain(`skip publish: ${second}@0.0.0`);
	});

	test('removes the sandbox home when publish fails', async () => {
		registry = startFakeRegistry();
		const name = '@victor-software-house/bootstrap-fail';
		const root = join(tmpdir(), `bun-release-bootstrap-fail-${Date.now()}`);
		const binDir = join(root, 'bin');
		const homePath = join(root, 'sandbox-home');
		writeFakeBun(binDir, registry.url, { name, homePath });
		env.PATH = `${binDir}:${originalPath ?? ''}`;
		const packages = [{ name, version: '0.0.0', directory: stagedPackage(root, name, '0.0.0') }];
		let message = '';
		try {
			await bootstrapNpmPackages(packages, 'victor-software-house/exa-cli', 'release.yml', {
				registry: registry.url,
				publishRetry: fastPublish,
				loginRetry: fastLogin,
				openUrl: async () => undefined,
			});
		} catch (error) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message.length > 0).toBe(true);
		const sandboxHome = (await Bun.file(homePath).text()).trim();
		expect(sandboxHome.length > 0).toBe(true);
		expect(existsSync(sandboxHome)).toBe(false);
	});
});
