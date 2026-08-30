import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { env, stdout } from 'node:process';
import { NPM_REGISTRY, registryHasVersion, waitForRegistryVersion } from '@release/registry';
import type { RetryOptions } from '@release/retry';
import {
	loginRetry as defaultLoginRetry,
	publishRetry as defaultPublishRetry,
	retry,
} from '@release/retry';
import { $ } from 'bun';
import { AbortError } from 'p-retry';
import { match, P } from 'ts-pattern';

const CANONICAL_REGISTRY_HOST = 'registry.npmjs.org';
const TRUST_PUBLISH = 'createPackage';

export type NpmBootstrapPackage = {
	name: string;
	version: string;
	directory: string;
};

export type OpenLoginUrl = (url: string) => Promise<void>;

export type NpmBootstrapOptions = {
	registry?: string;
	publishRetry?: RetryOptions;
	loginRetry?: RetryOptions;
	openUrl?: OpenLoginUrl;
};

type TrustEntry = {
	type: string;
	repository: string;
	file: string;
	permissions: readonly string[];
};

function trailingSlash(registry: string): string {
	return registry.endsWith('/') ? registry : `${registry}/`;
}

function registryPath(registry: string, path: string): URL {
	return new URL(path, trailingSlash(registry));
}

function escapedPackageName(name: string): string {
	return name.replace('/', '%2F');
}

function isHttpUrl(value: string): boolean {
	try {
		return match(new URL(value).protocol)
			.with('https:', () => true)
			.with('http:', () => true)
			.otherwise(() => false);
	} catch {
		return false;
	}
}

function replaceDoneUrlOrigin(doneUrl: string, registry: string): string {
	const done = new URL(doneUrl);
	if (done.hostname !== CANONICAL_REGISTRY_HOST) {
		return doneUrl;
	}
	const origin = new URL(trailingSlash(registry));
	done.protocol = origin.protocol;
	done.host = origin.host;
	const prefix = origin.pathname.replace(/\/$/, '');
	if (prefix !== '' && prefix !== '/' && !done.pathname.startsWith(prefix)) {
		done.pathname = `${prefix}${done.pathname}`;
	}
	return done.href;
}

function npmrcAuthLine(registry: string, token: string): string {
	const url = new URL(trailingSlash(registry));
	return `//${url.host}${url.pathname}:_authToken=${token}\n`;
}

function assertOwnerRepo(repository: string): void {
	const parts = repository.split('/');
	if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
		throw new Error('repository must be owner/repo');
	}
}

function assertWorkflowFile(workflow: string): void {
	if (workflow !== basename(workflow)) {
		throw new Error('workflow must be a filename, not a path');
	}
	if (!(workflow.endsWith('.yml') || workflow.endsWith('.yaml'))) {
		throw new Error('workflow must end in .yml or .yaml');
	}
}

type IsolatedPublishEnv = {
	PATH: string;
	HOME: string;
	TMPDIR: string;
};

function isolatedPublishEnv(sandboxHome: string): IsolatedPublishEnv {
	const path = env.PATH;
	if (path === undefined || path === '') {
		throw new Error('PATH is required to run bun publish');
	}
	return {
		PATH: path,
		HOME: sandboxHome,
		TMPDIR: join(sandboxHome, 'tmp'),
	};
}

async function openLoginUrl(url: string): Promise<void> {
	stdout.write(`Authorize npm login at ${url}\n`);
	const result = await match(platform())
		.with('darwin', async () => $`open ${url}`.nothrow().quiet())
		.with('win32', async () => $`cmd /c start ${url}`.nothrow().quiet())
		.otherwise(async () => $`xdg-open ${url}`.nothrow().quiet());
	if (result.exitCode !== 0) {
		stdout.write('Could not open a browser automatically; open the URL above.\n');
	}
}

async function requestLoginUrls(registry: string): Promise<{ loginUrl: string; doneUrl: string }> {
	const response = await fetch(registryPath(registry, '-/v1/login'), {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		body: '{}',
	});
	if (!response.ok) {
		throw new Error(`npm web login failed (${response.status})`);
	}
	const body: unknown = await response.json();
	return match(body)
		.with(
			{ loginUrl: P.string.minLength(1), doneUrl: P.string.minLength(1) },
			({ loginUrl, doneUrl }) => {
				if (!isHttpUrl(loginUrl) || !isHttpUrl(doneUrl)) {
					throw new Error('npm web login returned a non-http URL');
				}
				return { loginUrl, doneUrl: replaceDoneUrlOrigin(doneUrl, registry) };
			},
		)
		.otherwise(() => {
			throw new Error('npm web login missing loginUrl or doneUrl');
		});
}

async function pollLoginToken(doneUrl: string, options: RetryOptions): Promise<string> {
	return retry(async () => {
		const response = await fetch(doneUrl, { cache: 'no-store' });
		if (response.status === 202) {
			throw new Error('npm web login still pending');
		}
		if (response.status !== 200) {
			throw new AbortError(`npm web login poll failed (${response.status})`);
		}
		const body: unknown = await response.json();
		return match(body)
			.with({ token: P.string.minLength(1) }, ({ token }) => token)
			.otherwise(() => {
				throw new AbortError('npm web login missing token');
			});
	}, options);
}

async function loginWeb(
	registry: string,
	openUrl: OpenLoginUrl,
	options: RetryOptions,
): Promise<string> {
	const { loginUrl, doneUrl } = await requestLoginUrls(registry);
	const opened = openUrl(loginUrl);
	try {
		return await pollLoginToken(doneUrl, options);
	} finally {
		await opened.catch(() => undefined);
	}
}

type NpmJsonHeaders = {
	Accept: string;
	Authorization: string;
	'Content-Type': string;
};

function bearerHeaders(token: string): NpmJsonHeaders {
	return {
		Accept: 'application/json',
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json',
	};
}

function hasMatchingTrust(
	entries: readonly TrustEntry[],
	repository: string,
	workflow: string,
): boolean {
	return entries.some(
		(entry) =>
			entry.type === 'github' &&
			entry.repository === repository &&
			entry.file === workflow &&
			entry.permissions.includes(TRUST_PUBLISH),
	);
}

function trustUrl(name: string, registry: string): URL {
	return registryPath(registry, `-/package/${escapedPackageName(name)}/trust`);
}

async function listTrust(
	name: string,
	registry: string,
	token: string,
): Promise<readonly TrustEntry[]> {
	const response = await fetch(trustUrl(name, registry), { headers: bearerHeaders(token) });
	if (response.status === 404) {
		return [];
	}
	if (!response.ok) {
		throw new Error(`npm trust list failed (${response.status}) for ${name}`);
	}
	const body: unknown = await response.json();
	return match(body)
		.with(
			P.array({
				type: P.string,
				claims: {
					repository: P.string,
					workflow_ref: { file: P.string },
				},
				permissions: P.optional(P.array(P.string)),
			}),
			(items) =>
				items.map(({ type, claims, permissions }) => ({
					type,
					repository: claims.repository,
					file: claims.workflow_ref.file,
					permissions: permissions ?? [],
				})),
		)
		.otherwise(() => []);
}

async function createGithubTrust(
	name: string,
	registry: string,
	token: string,
	repository: string,
	workflow: string,
): Promise<void> {
	const response = await fetch(trustUrl(name, registry), {
		method: 'POST',
		headers: bearerHeaders(token),
		body: JSON.stringify([
			{
				type: 'github',
				claims: { repository, workflow_ref: { file: workflow } },
				permissions: [TRUST_PUBLISH],
			},
		]),
	});
	if (!response.ok) {
		throw new Error(`npm trust create failed (${response.status}) for ${name}`);
	}
}

async function ensureGithubTrust(
	name: string,
	registry: string,
	token: string,
	repository: string,
	workflow: string,
): Promise<void> {
	if (hasMatchingTrust(await listTrust(name, registry, token), repository, workflow)) {
		return;
	}
	await createGithubTrust(name, registry, token, repository, workflow);
	const after = await listTrust(name, registry, token);
	if (!hasMatchingTrust(after, repository, workflow)) {
		const summary = after
			.map((entry) => `${entry.type}:${entry.repository}:${entry.file}`)
			.join(', ');
		throw new Error(
			`npm trust verification failed for ${name} (wanted github:${repository}:${workflow}; saw ${summary || 'none'})`,
		);
	}
}

async function publishPackage(
	pkg: NpmBootstrapPackage,
	registry: string,
	sandboxHome: string,
	options: RetryOptions,
): Promise<void> {
	if (await registryHasVersion(pkg.name, pkg.version, registry)) {
		stdout.write(`skip publish: ${pkg.name}@${pkg.version} is already on npm\n`);
		return;
	}
	await $`bun publish --access public --registry ${registry}`
		.cwd(pkg.directory)
		.env(isolatedPublishEnv(sandboxHome));
	await waitForRegistryVersion(pkg.name, pkg.version, registry, options);
}

export async function bootstrapNpmPackages(
	packages: readonly NpmBootstrapPackage[],
	repository: string,
	workflow: string,
	options: NpmBootstrapOptions = {},
): Promise<void> {
	assertOwnerRepo(repository);
	assertWorkflowFile(workflow);
	const registry = options.registry ?? NPM_REGISTRY;
	const selectedPublishRetry = options.publishRetry ?? defaultPublishRetry;
	const selectedLoginRetry = options.loginRetry ?? defaultLoginRetry;
	const openUrl = options.openUrl ?? openLoginUrl;
	const token = await loginWeb(registry, openUrl, selectedLoginRetry);
	const sandboxHome = await mkdtemp(join(tmpdir(), 'bun-release-bootstrap-'));
	try {
		await mkdir(join(sandboxHome, 'tmp'));
		await writeFile(join(sandboxHome, '.npmrc'), npmrcAuthLine(registry, token), { mode: 0o600 });
		for (const pkg of packages) {
			await publishPackage(pkg, registry, sandboxHome, selectedPublishRetry);
			await ensureGithubTrust(pkg.name, registry, token, repository, workflow);
			stdout.write(`bootstrapped ${pkg.name}@${pkg.version}\n`);
		}
	} finally {
		await rm(sandboxHome, { recursive: true, force: true });
	}
}
