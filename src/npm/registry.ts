import { NPM_BEARER, npmRegistryClient } from '@release/npm/client';
import { httpStatusError } from '@release/npm/http';
import { escapedPackagePath, NPM_REGISTRY } from '@release/npm/url';
import type { RetryOptions } from '@release/release/retry';
import { publishRetry, retry } from '@release/release/retry';
import { match, P } from 'ts-pattern';

export { NPM_REGISTRY };

export async function registryHasVersion(
	name: string,
	version: string,
	registry: string = NPM_REGISTRY,
	token?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const result = await match(token)
		.with(P.string.minLength(1), (authToken) =>
			npmRegistryClient(registry, authToken).get({
				throwOnError: false,
				cache: 'no-store',
				signal: signal ?? null,
				url: escapedPackagePath(name),
				security: [NPM_BEARER],
			}),
		)
		.otherwise(() =>
			npmRegistryClient(registry).get({
				throwOnError: false,
				cache: 'no-store',
				signal: signal ?? null,
				url: escapedPackagePath(name),
			}),
		);
	return match(result)
		.with({ response: { status: 404 } }, () => false)
		.with(
			{ response: { status: 200 }, data: { versions: P.record(P.string, P.unknown) } },
			({ data }) => version in data.versions,
		)
		.with({ response: { status: 200 } }, () => {
			throw new Error(`npm registry packument missing versions for ${name}@${version}`);
		})
		.with({ response: { status: P.number } }, ({ response, error }) =>
			httpStatusError(
				`npm registry lookup failed for ${name}@${version}`,
				response.status,
				match(error)
					.with(P.string, (text) => text)
					.with({ error: P.string }, ({ error: text }) => text)
					.otherwise(() => ''),
			),
		)
		.otherwise(() => {
			throw new Error(`npm registry lookup failed (unknown) for ${name}@${version}`);
		});
}

export async function waitForRegistryVersion(
	name: string,
	version: string,
	registry: string = NPM_REGISTRY,
	options: RetryOptions = publishRetry,
	token?: string,
): Promise<void> {
	await retry(async () => {
		match(await registryHasVersion(name, version, registry, token, options.signal))
			.with(true, () => undefined)
			.with(false, () => {
				throw new Error(`npm registry did not observe ${name}@${version}`);
			})
			.exhaustive();
	}, options);
}
