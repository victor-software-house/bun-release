import { basename } from 'node:path';
import { stdout } from 'node:process';
import { NPM_BEARER, npmRegistryClient } from '@release/npm/client';
import { httpStatusError } from '@release/npm/http';
import { escapedPackageName, escapedPackagePath, registryPath } from '@release/npm/url';
import type { NpmErrorBody, OpenUrl } from '@release/npm/web-auth';
import { completeOtpFrom401, isOtpChallenge, NpmErrorBodySchema } from '@release/npm/web-auth';
import type { RetryOptions } from '@release/release/retry';
import { loginRetry as defaultLoginRetry } from '@release/release/retry';
import type { AfterResponseHook } from 'ky';
import ky from 'ky';
import { match, P } from 'ts-pattern';

export const GITHUB_TRUST_PUBLISH = 'createPackage';

export type TrustEntry = {
	type: string;
	repository: string;
	file: string;
	permissions: readonly string[];
};

export type GithubTrustedPublisher = {
	repository: string;
	workflow: string;
};

export type EnsureGithubTrustOptions = {
	otp?: string;
	openUrl?: OpenUrl;
	loginRetry?: RetryOptions;
};

type TrustHeaders = {
	'npm-auth-type': 'web';
	'npm-otp'?: string;
};

type TrustAttempt = {
	status: number;
	error: string;
	body: NpmErrorBody | undefined;
	response: Response;
	data: unknown;
};

export function assertOwnerRepo(repository: string): void {
	match(repository.split('/'))
		.with([P.string.minLength(1), P.string.minLength(1)], () => undefined)
		.otherwise(() => {
			throw new Error('repository must be owner/repo');
		});
}

export function assertWorkflowFile(workflow: string): void {
	match({
		basename: workflow === basename(workflow),
		yaml: workflow.endsWith('.yml') || workflow.endsWith('.yaml'),
	})
		.with({ basename: false }, () => {
			throw new Error('workflow must be a filename, not a path');
		})
		.with({ yaml: false }, () => {
			throw new Error('workflow must end in .yml or .yaml');
		})
		.with({ basename: true, yaml: true }, () => undefined)
		.exhaustive();
}

export function trustUrl(name: string, registry: string): URL {
	return registryPath(registry, `-/package/${escapedPackageName(name)}/trust`);
}

export function hasMatchingTrust(
	entries: readonly TrustEntry[],
	target: GithubTrustedPublisher,
): boolean {
	return entries.some(
		(entry) =>
			entry.type === 'github' &&
			entry.repository === target.repository &&
			entry.file === target.workflow &&
			entry.permissions.includes(GITHUB_TRUST_PUBLISH),
	);
}

type TrustWire = {
	type: string;
	claims: { repository: string; workflow_ref: { file: string } };
	permissions?: string[] | undefined;
};

function flattenTrust(items: readonly TrustWire[]): TrustEntry[] {
	return items.map(({ type, claims, permissions }) => ({
		type,
		repository: claims.repository,
		file: claims.workflow_ref.file,
		permissions: permissions ?? [],
	}));
}

function trustHeaders(otp?: string): TrustHeaders {
	return match(otp)
		.returnType<TrustHeaders>()
		.with(P.string.minLength(1), (headerOtp) => ({
			'npm-auth-type': 'web',
			'npm-otp': headerOtp,
		}))
		.otherwise(() => ({
			'npm-auth-type': 'web',
		}));
}

function registryErrorText(error: NpmErrorBody | undefined): string {
	return match(error)
		.with(P.string, (text) => text)
		.with({ error: P.string }, ({ error: text }) => text)
		.otherwise(() => '');
}

async function trustAttempt(
	method: 'get' | 'post',
	name: string,
	registry: string,
	token: string,
	otp: string | undefined,
	body?: readonly TrustWire[],
): Promise<TrustAttempt> {
	const client = npmRegistryClient(registry, token);
	let retryCount = 0;
	const retryOnRateLimit: AfterResponseHook = async (_request, _options, response) => {
		if (response.status !== 429) {
			return response;
		}
		if (otp !== undefined) {
			stdout.write(
				`trust ${method.toUpperCase()} ${name}: rate limited with one-time password; not replaying it\n`,
			);
			return response;
		}
		retryCount += 1;
		if (retryCount > 10) {
			return response;
		}
		const retryAfter = response.headers.get('retry-after');
		const seconds = Number(retryAfter);
		const fallback = Math.min(2_000 * 2 ** (retryCount - 1), 30_000);
		const delay =
			retryAfter !== null && Number.isFinite(seconds) && seconds > 0
				? Math.max(1_000, seconds * 1_000)
				: fallback;
		stdout.write(
			`trust ${method.toUpperCase()} ${name}: rate limited, retry ${retryCount}/10 in ${Math.round(delay / 1_000)}s\n`,
		);
		return ky.retry({ delay });
	};
	const request = {
		throwOnError: false as const,
		url: `/-/package${escapedPackagePath(name)}/trust`,
		security: [NPM_BEARER],
		headers: trustHeaders(otp),
		retry: {
			limit: 10,
			methods: ['get', 'post'],
		},
		kyOptions: {
			hooks: {
				afterResponse: [retryOnRateLimit],
			},
		},
	};
	const result = await match(method)
		.with('get', () => client.get(request))
		.with('post', () => client.post({ ...request, body }))
		.exhaustive();
	const parsedError = NpmErrorBodySchema.safeParse(result.error);
	const bodyError = match(parsedError)
		.with({ success: true }, ({ data }) => data)
		.otherwise(() => undefined);
	return match(result.response)
		.with(P.instanceOf(Response), (response) => {
			const attempt = {
				status: response.status,
				error: registryErrorText(bodyError),
				body: bodyError,
				response,
				data: result.data,
			};
			stdout.write(`trust ${method.toUpperCase()} ${name} → ${attempt.status}\n`);
			return attempt;
		})
		.otherwise(() => {
			throw new Error(`npm trust ${method} produced no response for ${name}`);
		});
}

function otpRequiredError(name: string, action: string, response: Response, text: string): Error {
	const hint = isOtpChallenge(response, text);
	return new Error(
		match({ hint, text })
			.with(
				{ hint: true, text: P.string.minLength(1) },
				({ text: detail }) =>
					`npm trust ${action} needs otp without authUrl/doneUrl (${name}): ${detail}`,
			)
			.with({ hint: true }, () => `npm trust ${action} needs otp without authUrl/doneUrl (${name})`)
			.with(
				{ text: P.string.minLength(1) },
				({ text: detail }) => `npm trust ${action} unauthorized (${name}): ${detail}`,
			)
			.otherwise(() => `npm trust ${action} unauthorized (${name})`),
	);
}

async function completeTrustOtp(
	attempt: TrustAttempt,
	registry: string,
	openUrl: OpenUrl | undefined,
	loginRetry: RetryOptions,
): Promise<string | undefined> {
	return match(attempt.status)
		.with(401, async () =>
			match(await completeOtpFrom401(attempt.body, registry, openUrl, loginRetry))
				.with(P.string.minLength(1), (sessionOtp) => sessionOtp)
				.otherwise(() => undefined),
		)
		.otherwise(() => undefined);
}

function listEntries(name: string, attempt: TrustAttempt): readonly TrustEntry[] {
	return match(attempt)
		.with({ status: 404 }, () => [])
		.with(
			{
				status: 200,
				data: P.array({
					type: P.string,
					claims: {
						repository: P.string,
						workflow_ref: { file: P.string },
					},
					permissions: P.optional(P.array(P.string)),
				}),
			},
			({ data }) => flattenTrust(data),
		)
		.with({ status: 200 }, () => [])
		.with({ status: P.number }, ({ status, error }) =>
			httpStatusError(`npm trust list failed for ${name}`, status, error),
		)
		.otherwise(() => {
			throw new Error(`npm trust list failed (unknown) for ${name}`);
		});
}

function assertCreated(name: string, attempt: TrustAttempt): void {
	match(attempt)
		.with({ status: P.union(200, 201) }, () => undefined)
		.with({ status: P.number }, ({ status, error, body }) =>
			httpStatusError(
				`npm trust create failed for ${name}`,
				status,
				match({ error, body })
					.with({ error: P.string.minLength(1) }, ({ error: text }) => text)
					.with({ body: P.string.minLength(1) }, ({ body: text }) => text)
					.otherwise(({ body: raw }) => JSON.stringify(raw ?? {})),
			),
		)
		.otherwise(() => {
			throw new Error(`npm trust create failed (unknown) for ${name}`);
		});
}

export async function listTrust(
	name: string,
	registry: string,
	token: string,
	otp?: string,
): Promise<readonly TrustEntry[]> {
	return listEntries(name, await trustAttempt('get', name, registry, token, otp));
}

export async function createGithubTrust(
	name: string,
	registry: string,
	token: string,
	target: GithubTrustedPublisher,
	otp?: string,
): Promise<void> {
	assertCreated(
		name,
		await trustAttempt('post', name, registry, token, otp, [
			{
				type: 'github',
				claims: { repository: target.repository, workflow_ref: { file: target.workflow } },
				permissions: [GITHUB_TRUST_PUBLISH],
			},
		]),
	);
}

async function retryAfterOtp(
	name: string,
	action: string,
	attempt: TrustAttempt,
	otp: string | undefined,
	openUrl: OpenUrl | undefined,
	registry: string,
	loginRetry: RetryOptions,
	retry: (sessionOtp: string) => Promise<TrustAttempt>,
	withoutOtp: () => Promise<TrustAttempt>,
): Promise<{ attempt: TrustAttempt; otp: string | undefined }> {
	return match(attempt.status)
		.with(401, async () => {
			const fromChallenge = await completeTrustOtp(attempt, registry, openUrl, loginRetry);
			const sessionOtp = await match(fromChallenge)
				.with(P.string.minLength(1), async (headerOtp) => headerOtp)
				.otherwise(async () =>
					match({
						otp: isOtpChallenge(attempt.response, attempt.error),
						hadOtp: Boolean(otp),
					})
						.with({ otp: true, hadOtp: true }, async () => {
							stdout.write(
								`trust ${action} ${name}: 401 had no challenge URLs; retrying without npm-otp\n`,
							);
							return completeTrustOtp(await withoutOtp(), registry, openUrl, loginRetry);
						})
						.otherwise(() => undefined),
				);
			return match(sessionOtp)
				.with(P.string.minLength(1), async (headerOtp) => ({
					attempt: await retry(headerOtp),
					otp: headerOtp,
				}))
				.otherwise(() => {
					throw otpRequiredError(name, action, attempt.response, attempt.error);
				});
		})
		.otherwise(() => ({ attempt, otp }));
}

async function listTrustWithOtp(
	name: string,
	registry: string,
	token: string,
	otp: string | undefined,
	openUrl: OpenUrl | undefined,
	loginRetry: RetryOptions,
): Promise<{ entries: readonly TrustEntry[]; otp: string | undefined }> {
	const retried = await retryAfterOtp(
		name,
		'list',
		await trustAttempt('get', name, registry, token, otp),
		otp,
		openUrl,
		registry,
		loginRetry,
		(sessionOtp) => trustAttempt('get', name, registry, token, sessionOtp),
		() => trustAttempt('get', name, registry, token, undefined),
	);
	return { entries: listEntries(name, retried.attempt), otp: retried.otp };
}

export async function ensureGithubTrust(
	name: string,
	registry: string,
	token: string,
	target: GithubTrustedPublisher,
	options: EnsureGithubTrustOptions = {},
): Promise<string | undefined> {
	const loginRetry = options.loginRetry ?? defaultLoginRetry;
	const listed = await listTrustWithOtp(
		name,
		registry,
		token,
		options.otp,
		options.openUrl,
		loginRetry,
	);
	return match(hasMatchingTrust(listed.entries, target))
		.with(true, () => listed.otp)
		.with(false, async () => {
			const body = [
				{
					type: 'github',
					claims: { repository: target.repository, workflow_ref: { file: target.workflow } },
					permissions: [GITHUB_TRUST_PUBLISH],
				},
			];
			const retried = await retryAfterOtp(
				name,
				'create',
				await trustAttempt('post', name, registry, token, listed.otp, body),
				listed.otp,
				options.openUrl,
				registry,
				loginRetry,
				(sessionOtp) => trustAttempt('post', name, registry, token, sessionOtp, body),
				() => trustAttempt('post', name, registry, token, undefined, body),
			);
			assertCreated(name, retried.attempt);
			return retried.otp;
		})
		.exhaustive();
}
