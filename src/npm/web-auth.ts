import { hostname as osHostname, platform } from 'node:os';
import { stdout } from 'node:process';
import { loginWeb as postLoginWeb } from '@release/generated/sdk.gen';
import type { OtpChallenge, SessionToken } from '@release/generated/types.gen';
import { OtpChallengeSchema, SessionTokenSchema } from '@release/generated/zod.gen';
import { npmRegistryClient } from '@release/npm/client';
import { httpStatusError } from '@release/npm/http';
import { isHttpUrl, rewriteRegistryDoneUrl } from '@release/npm/url';
import type { RetryOptions } from '@release/release/retry';
import { loginRetry } from '@release/release/retry';
import { $ } from 'bun';
import ky from 'ky';
import { match, P } from 'ts-pattern';
import * as z from 'zod';

export type OpenUrl = (url: string) => Promise<void>;

export type WebAuthUrls = {
	loginUrl: string;
	doneUrl: string;
};

export const NpmErrorBodySchema = z.union([
	z.string().trim(),
	z.looseObject({
		error: z.string().trim().optional(),
		message: z.string().trim().optional(),
		authUrl: z.url().optional(),
		loginUrl: z.url().optional(),
		doneUrl: z.url().optional(),
	}),
]);

export type NpmErrorBody = z.output<typeof NpmErrorBodySchema>;

export type OpenUrlOptions = {
	openUrl?: OpenUrl;
	browser?: boolean;
};

export async function printAuthorizeUrl(url: string): Promise<void> {
	stdout.write(`Authorize npm at ${url}\n`);
}

export async function openAuthorizeUrl(url: string): Promise<void> {
	await printAuthorizeUrl(url);
	const result = await match(platform())
		.with('darwin', async () => $`open ${url}`.nothrow().quiet())
		.with('win32', async () => $`cmd /c start ${url}`.nothrow().quiet())
		.otherwise(async () => $`xdg-open ${url}`.nothrow().quiet());
	match(result.exitCode)
		.with(0, () => undefined)
		.otherwise(() => {
			stdout.write('Could not open a browser automatically; open the URL above.\n');
		});
}

export function resolveOpenUrl(options: OpenUrlOptions): OpenUrl {
	return match(options)
		.with({ openUrl: P.nonNullable }, ({ openUrl }) => openUrl)
		.with({ browser: false }, () => printAuthorizeUrl)
		.otherwise(() => openAuthorizeUrl);
}

function retryAfterDelay(response: Response, interval: number): number {
	const seconds = match(response.headers.get('retry-after'))
		.with(P.nullish, () => 0)
		.when(
			(value) => value.trim() === '',
			() => 0,
		)
		.otherwise((value) => Number(value.trim()));
	return match(Number.isFinite(seconds))
		.with(true, () => Math.max(interval, seconds * 1000))
		.otherwise(() => interval);
}

function pollHeartbeat(): (status: number, delayMs: number) => void {
	const started = Date.now();
	return (status: number, delayMs: number) => {
		const elapsed = Math.round((Date.now() - started) / 1000);
		const next = Math.round(delayMs / 1000);
		stdout.write(`still polling (elapsed ${elapsed}s, GET ${status}, next in ${next}s)\n`);
	};
}

async function pollBody(response: Response): Promise<SessionToken | undefined> {
	return match(response.status)
		.with(200, async () => {
			const body = await response
				.clone()
				.json()
				.catch(() => undefined);
			return match(SessionTokenSchema.safeParse(body))
				.with({ success: true }, ({ data }) => data)
				.otherwise(() => undefined);
		})
		.otherwise(() => undefined);
}

async function pollPendingRetry(
	response: Response,
	interval: number,
	onPending: (status: number, delayMs: number) => void,
) {
	const body = await pollBody(response);
	return match({ status: response.status, body })
		.with({ status: 200, body: { token: P.string.minLength(1) } }, () => undefined)
		.otherwise(({ status }) => {
			const delay = match(status)
				.with(202, () => retryAfterDelay(response, interval))
				.otherwise(() => interval);
			onPending(status, delay);
			return ky.retry({ delay });
		});
}

export async function pollWebToken(
	doneUrl: string,
	options: RetryOptions = loginRetry,
): Promise<string> {
	const done = new URL(doneUrl);
	const client = npmRegistryClient(done.origin);
	const interval = options.minTimeout;
	const budget = AbortSignal.timeout(options.maxRetryTime);
	const onPending = pollHeartbeat();
	try {
		await Bun.sleep(interval);
		const result = await client.get({
			throwOnError: false,
			cache: 'no-store',
			url: `${done.pathname}${done.search}`,
			retry: {
				limit: options.retries,
				delay: () => interval,
				methods: ['get'],
			},
			signal: budget,
			kyOptions: {
				hooks: {
					afterResponse: [
						async (_request, _options, response) => pollPendingRetry(response, interval, onPending),
					],
				},
			},
		});
		return match(result)
			.with({ response: { status: 200 }, data: { token: P.string.minLength(1) } }, ({ data }) => {
				stdout.write('got npm web token\n');
				return data.token;
			})
			.otherwise(() => {
				throw new Error('npm web auth pending');
			});
	} catch {
		throw match(budget.aborted)
			.with(true, () => new Error('npm web auth timed out'))
			.otherwise(() => new Error('npm web auth pending'));
	}
}

export async function completeWebAuth(
	urls: WebAuthUrls,
	openUrl: OpenUrl,
	options: RetryOptions = loginRetry,
): Promise<string> {
	const opened = openUrl(urls.loginUrl);
	try {
		return await pollWebToken(urls.doneUrl, options);
	} finally {
		await opened.catch(() => undefined);
	}
}

function urlsFromPair(
	loginUrl: string,
	doneUrl: string,
	registry: string,
): WebAuthUrls | undefined {
	return match({ login: isHttpUrl(loginUrl), done: isHttpUrl(doneUrl) })
		.with({ login: true, done: true }, () => ({
			loginUrl,
			doneUrl: rewriteRegistryDoneUrl(doneUrl, registry),
		}))
		.otherwise(() => undefined);
}

function rewriteLoginUrls(loginUrl: string, doneUrl: string, registry: string): WebAuthUrls {
	return match(urlsFromPair(loginUrl, doneUrl, registry))
		.with(P.nonNullable, (urls) => urls)
		.otherwise(() => {
			throw new Error('npm web login missing loginUrl or doneUrl');
		});
}

export async function requestLoginUrls(
	registry: string,
	host: string = osHostname(),
): Promise<WebAuthUrls> {
	const result = await postLoginWeb({
		client: npmRegistryClient(registry),
		throwOnError: false,
		headers: {
			'npm-auth-type': 'web',
			'npm-command': 'login',
		},
		body: { hostname: host },
	});
	return match(result)
		.with({ response: { ok: true }, data: { loginUrl: P.string, doneUrl: P.string } }, ({ data }) =>
			rewriteLoginUrls(data.loginUrl, data.doneUrl, registry),
		)
		.with({ response: { status: P.number } }, ({ response, error }) =>
			httpStatusError(
				'npm web login failed',
				response.status,
				match(error)
					.with(P.string, (text) => text)
					.with({ error: P.string }, ({ error: text }) => text)
					.otherwise(() => ''),
			),
		)
		.otherwise(() => {
			throw new Error('npm web login missing loginUrl or doneUrl');
		});
}

export async function loginWeb(
	registry: string,
	openUrl: OpenUrl,
	options: RetryOptions = loginRetry,
): Promise<string> {
	return completeWebAuth(await requestLoginUrls(registry), openUrl, options);
}

export function parseOtpChallenge(error: NpmErrorBody | undefined): OtpChallenge | undefined {
	return match(OtpChallengeSchema.safeParse(error))
		.with(
			{
				success: true,
				data: { authUrl: P.string.minLength(1), doneUrl: P.string.minLength(1) },
			},
			({ data: { authUrl, doneUrl } }) => ({ authUrl, doneUrl }),
		)
		.otherwise(() => undefined);
}

export function otpChallengeUrls(
	challenge: OtpChallenge | undefined,
	registry: string,
): WebAuthUrls | undefined {
	return match(challenge)
		.with(
			{ authUrl: P.string.minLength(1), doneUrl: P.string.minLength(1) },
			({ authUrl, doneUrl }) => urlsFromPair(authUrl, doneUrl, registry),
		)
		.otherwise(() => undefined);
}

export function otpUrlsFromError(
	error: NpmErrorBody | undefined,
	registry: string,
): WebAuthUrls | undefined {
	return match(error)
		.with(
			{ authUrl: P.string.minLength(1), doneUrl: P.string.minLength(1) },
			({ authUrl, doneUrl }) => urlsFromPair(authUrl, doneUrl, registry),
		)
		.with(
			{ loginUrl: P.string.minLength(1), doneUrl: P.string.minLength(1) },
			({ loginUrl, doneUrl }) => urlsFromPair(loginUrl, doneUrl, registry),
		)
		.otherwise(() => otpChallengeUrls(parseOtpChallenge(error), registry));
}

export function isOtpWwwAuthenticate(response: Response): boolean {
	return match(response.headers.get('www-authenticate'))
		.with(P.nullish, () => false)
		.when(
			(value) => value.toLowerCase().includes('otp'),
			() => true,
		)
		.otherwise(() => false);
}

export function isOtpChallenge(response: Response, text: string): boolean {
	return isOtpWwwAuthenticate(response) || text.includes('one-time pass');
}

export async function completeOtpFrom401(
	error: NpmErrorBody | undefined,
	registry: string,
	openUrl: OpenUrl | undefined,
	options: RetryOptions = loginRetry,
): Promise<string | undefined> {
	return match({
		urls: otpUrlsFromError(error, registry),
		openUrl,
	})
		.with({ urls: P.nonNullable, openUrl: P.nonNullable }, async ({ urls, openUrl: open }) =>
			completeWebAuth(urls, open, options),
		)
		.otherwise(() => undefined);
}
