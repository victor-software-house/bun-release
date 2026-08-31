import { stdout } from 'node:process';
import { NPM_BEARER, npmRegistryClient } from '@release/npm/client';
import { httpStatusError } from '@release/npm/http';
import type { PackedPublish } from '@release/npm/pack';
import { registryHasVersion } from '@release/npm/registry';
import type { NpmAccess } from '@release/npm/url';
import { escapedPackagePath } from '@release/npm/url';
import type { NpmErrorBody, OpenUrl } from '@release/npm/web-auth';
import { completeOtpFrom401, isOtpChallenge, NpmErrorBodySchema } from '@release/npm/web-auth';
import type { RetryOptions } from '@release/release/retry';
import { match, P } from 'ts-pattern';

export type PutNpmPackageOptions = {
	registry: string;
	document: PackedPublish;
	token: string;
	otp?: string;
	access?: NpmAccess;
};

type PublishHeaders = {
	'npm-auth-type': 'web';
	'npm-command': 'publish';
	'npm-otp'?: string;
};

function publishHeaders(otp?: string): PublishHeaders {
	return match(otp)
		.returnType<PublishHeaders>()
		.with(P.string.minLength(1), (publishOtp) => ({
			'npm-auth-type': 'web',
			'npm-command': 'publish',
			'npm-otp': publishOtp,
		}))
		.otherwise(() => ({
			'npm-auth-type': 'web',
			'npm-command': 'publish',
		}));
}

async function putNpmPackageResult(options: PutNpmPackageOptions): Promise<{
	status: number;
	error: string;
	body: NpmErrorBody | undefined;
	response: Response;
}> {
	const result = await npmRegistryClient(options.registry, options.token).put({
		throwOnError: false,
		timeout: false,
		url: escapedPackagePath(options.document.name),
		security: [NPM_BEARER],
		headers: {
			'Content-Type': 'application/json',
			...publishHeaders(options.otp),
		},
		body: options.document.document,
	});
	const parsedError = NpmErrorBodySchema.safeParse(result.error);
	const body = match(parsedError)
		.with({ success: true }, ({ data }) => data)
		.otherwise(() => undefined);
	const parsed = match(result.response)
		.with(P.instanceOf(Response), (response) => ({
			status: response.status,
			error: match(body)
				.with(P.string, (text) => text)
				.with({ error: P.string }, ({ error: text }) => text)
				.otherwise(() => ''),
			body,
			response,
		}))
		.otherwise(() => {
			throw new Error(`npm publish produced no response for ${options.document.name}`);
		});
	stdout.write(`PUT ${options.document.name}@${options.document.version} → ${parsed.status}\n`);
	match({ status: parsed.status, error: parsed.error })
		.with(
			{ status: P.when((status: number) => status >= 400), error: P.string.minLength(1) },
			({ error }) => {
				stdout.write(`${error}\n`);
			},
		)
		.otherwise(() => undefined);
	return parsed;
}

export async function putNpmPackage(options: PutNpmPackageOptions): Promise<Response> {
	return (await putNpmPackageResult(options)).response;
}

export function settleNpmPut(
	status: number,
	error: string,
	pkg: { name: string; version: string },
): void {
	match(status)
		.with(P.union(200, 201), () => {
			stdout.write(`accepted publish: ${pkg.name}@${pkg.version}\n`);
		})
		.with(409, () => {
			stdout.write(`skip publish: ${pkg.name}@${pkg.version} is already on npm\n`);
		})
		.otherwise(() => httpStatusError(`npm publish failed for ${pkg.name}`, status, error));
}

function otpRequiredError(name: string, response: Response, text: string): Error {
	const hint = isOtpChallenge(response, text);
	return new Error(
		match({ hint, text })
			.with(
				{ hint: true, text: P.string.minLength(1) },
				({ text: detail }) => `npm publish needs otp without authUrl/doneUrl (${name}): ${detail}`,
			)
			.with({ hint: true }, () => `npm publish needs otp without authUrl/doneUrl (${name})`)
			.with(
				{ text: P.string.minLength(1) },
				({ text: detail }) => `npm publish unauthorized (${name}): ${detail}`,
			)
			.otherwise(() => `npm publish unauthorized (${name})`),
	);
}

export type PublishWithOtpOptions = {
	registry: string;
	document: PackedPublish;
	token: string;
	otp?: string;
	access?: NpmAccess;
	openUrl: OpenUrl;
	loginRetry: RetryOptions;
};

export async function putNpmPackageWithOtp(
	options: PublishWithOtpOptions,
): Promise<{ otp: string | undefined }> {
	const { registry, document, openUrl, loginRetry } = options;
	const first = await putNpmPackageResult(options);
	if (first.status !== 401) {
		settleNpmPut(first.status, first.error, document);
		return { otp: options.otp };
	}

	let challenge = first;
	let sessionOtp = await completeOtpFrom401(challenge.body, registry, openUrl, loginRetry);
	if (sessionOtp === undefined && options.otp !== undefined) {
		stdout.write(`publish ${document.name}: 401 had no challenge URLs; retrying without npm-otp\n`);
		const { otp: _spentOtp, ...withoutOtp } = options;
		challenge = await putNpmPackageResult(withoutOtp);
		sessionOtp = await completeOtpFrom401(challenge.body, registry, openUrl, loginRetry);
		if (challenge.status !== 401) {
			settleNpmPut(challenge.status, challenge.error, document);
			return { otp: undefined };
		}
	}
	if (sessionOtp === undefined) {
		throw otpRequiredError(document.name, challenge.response, challenge.error);
	}

	const retry = await putNpmPackageResult({ ...options, otp: sessionOtp });
	settleNpmPut(retry.status, retry.error, document);
	return { otp: sessionOtp };
}

export async function skipIfPublished(
	name: string,
	version: string,
	registry: string,
	token?: string,
): Promise<boolean> {
	return match(await registryHasVersion(name, version, registry, token))
		.with(false, () => false)
		.with(true, () => {
			stdout.write(`skip publish: ${name}@${version} is already on npm\n`);
			return true;
		})
		.exhaustive();
}
