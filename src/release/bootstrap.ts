import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdout } from 'node:process';
import type { PackedDirectory, PackedPublish } from '@release/npm/pack';
import { packPublishDocument } from '@release/npm/pack';
import type { PublishWithOtpOptions } from '@release/npm/put';
import { putNpmPackageWithOtp } from '@release/npm/put';
import { NPM_REGISTRY, registryHasVersion, waitForRegistryVersion } from '@release/npm/registry';
import { assertOwnerRepo, assertWorkflowFile, ensureGithubTrust } from '@release/npm/trust';
import type { OpenUrl, OpenUrlOptions } from '@release/npm/web-auth';
import { loginWeb, resolveOpenUrl } from '@release/npm/web-auth';
import type { RetryOptions } from '@release/release/retry';
import { bootstrapVisibilityRetry, loginRetry as defaultLoginRetry } from '@release/release/retry';
import { match, P } from 'ts-pattern';

export type NpmBootstrapPackage = PackedDirectory;

export type NpmBootstrapOptions = OpenUrlOptions & {
	registry?: string;
	visibilityRetry?: RetryOptions;
	loginRetry?: RetryOptions;
	trustIntervalMs?: number;
};

type PreparedPackage = {
	pkg: NpmBootstrapPackage;
	document?: PackedPublish;
};

type VisibilityFailure = {
	pkg: NpmBootstrapPackage;
	error: Error;
};

function attachmentLength(document: PackedPublish): number {
	return Object.values(document.document['_attachments']).reduce((sum, row) => sum + row.length, 0);
}

function elapsedSeconds(started: number): number {
	return Math.round((performance.now() - started) / 1000);
}

function publishOptions(
	document: PackedPublish,
	registry: string,
	token: string,
	otp: string | undefined,
	openUrl: OpenUrl,
	loginRetry: RetryOptions,
): PublishWithOtpOptions {
	const shared = { registry, document, token, openUrl, loginRetry };
	return match(otp)
		.with(P.string.minLength(1), (currentOtp) => ({ ...shared, otp: currentOtp }))
		.otherwise(() => shared);
}

function startVisibilityCheck(
	pkg: NpmBootstrapPackage,
	registry: string,
	options: RetryOptions,
): Promise<VisibilityFailure | undefined> {
	const started = performance.now();
	stdout.write(`[visible ${pkg.name}] polling ${pkg.version}\n`);
	return waitForRegistryVersion(pkg.name, pkg.version, registry, {
		...options,
		onFailedAttempt: async (context) => {
			stdout.write(
				`[visible ${pkg.name}] pending after ${elapsedSeconds(started)}s; ` +
					`attempt ${context.attemptNumber}, next in ${Math.round(context.retryDelay / 1000)}s\n`,
			);
			await options.onFailedAttempt?.(context);
		},
	})
		.then(() => {
			stdout.write(`[visible ${pkg.name}] ready after ${elapsedSeconds(started)}s\n`);
			return undefined;
		})
		.catch((error: Error) => ({ pkg, error }));
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
	const selectedVisibilityRetry = options.visibilityRetry ?? bootstrapVisibilityRetry;
	const selectedLoginRetry = options.loginRetry ?? defaultLoginRetry;
	const openUrl: OpenUrl = resolveOpenUrl(options);
	const packDir = await mkdtemp(join(tmpdir(), 'bun-release-bootstrap-'));
	try {
		stdout.write(`checking ${packages.length} npm packages\n`);
		const checked = await Promise.all(
			packages.map(async (pkg) => ({
				pkg,
				published: await registryHasVersion(pkg.name, pkg.version, registry),
			})),
		);
		const prepared: PreparedPackage[] = await Promise.all(
			checked.map(async ({ pkg, published }) => {
				if (published) {
					stdout.write(`[prepare ${pkg.name}] already published\n`);
					return { pkg };
				}
				stdout.write(`[prepare ${pkg.name}] packing\n`);
				return { pkg, document: await packPublishDocument(pkg, packDir, 'public', registry) };
			}),
		);

		const token = await loginWeb(registry, openUrl, selectedLoginRetry);
		stdout.write('npm web login complete\n');
		const visibilityController = new AbortController();
		const visibilitySignal = match(selectedVisibilityRetry.signal)
			.with(P.nonNullable, (signal) => AbortSignal.any([signal, visibilityController.signal]))
			.otherwise(() => visibilityController.signal);
		const visibilityOptions = { ...selectedVisibilityRetry, signal: visibilitySignal };
		const visibilityTasks: Promise<VisibilityFailure | undefined>[] = [];
		let otp: string | undefined;
		try {
			for (const { pkg, document } of prepared) {
				if (document === undefined) {
					continue;
				}
				stdout.write(`[publish ${pkg.name}] uploading ${attachmentLength(document)} bytes\n`);
				({ otp } = await putNpmPackageWithOtp(
					publishOptions(document, registry, token, otp, openUrl, selectedLoginRetry),
				));
				visibilityTasks.push(startVisibilityCheck(pkg, registry, visibilityOptions));
			}
		} catch (error) {
			visibilityController.abort(error);
			await Promise.all(visibilityTasks);
			throw error;
		}

		stdout.write(`waiting for ${visibilityTasks.length} published packages to become visible\n`);
		const visibilityFailures = (await Promise.all(visibilityTasks)).filter(
			(failure): failure is VisibilityFailure => failure !== undefined,
		);
		if (visibilityFailures.length > 0) {
			throw new AggregateError(
				visibilityFailures.map(({ error }) => error),
				`npm registry did not expose ${visibilityFailures.map(({ pkg }) => `${pkg.name}@${pkg.version}`).join(', ')}`,
			);
		}

		const trustIntervalMs =
			options.trustIntervalMs ??
			match(registry)
				.with(NPM_REGISTRY, () => 2_000)
				.otherwise(() => 0);
		for (const [index, { pkg }] of prepared.entries()) {
			if (index > 0 && trustIntervalMs > 0) {
				stdout.write(`waiting ${trustIntervalMs / 1_000}s before next npm trust request\n`);
				await Bun.sleep(trustIntervalMs);
			}
			stdout.write(`trust ${pkg.name}\n`);
			const trustOptions = match(otp)
				.with(P.string.minLength(1), (currentOtp) => ({
					otp: currentOtp,
					openUrl,
					loginRetry: selectedLoginRetry,
				}))
				.otherwise(() => ({ openUrl, loginRetry: selectedLoginRetry }));
			otp = await ensureGithubTrust(
				pkg.name,
				registry,
				token,
				{ repository, workflow },
				trustOptions,
			);
			stdout.write(`bootstrapped ${pkg.name}@${pkg.version}\n`);
		}
		stdout.write(`bootstrap complete: ${packages.length} packages visible and trusted\n`);
	} finally {
		await rm(packDir, { recursive: true, force: true });
	}
}
