import { npmRegistryClient } from '@release/npm/client';
import { httpStatusError } from '@release/npm/http';
import { NPM_REGISTRY } from '@release/npm/registry';
import { escapedPackagePath } from '@release/npm/url';
import { match, P } from 'ts-pattern';

async function githubActionsIdToken(
	requestUrl: string,
	requestToken: string,
	registry: string,
): Promise<string> {
	const githubUrl = new URL(requestUrl);
	githubUrl.searchParams.set('audience', `npm:${new URL(registry).hostname}`);
	const github = await fetch(githubUrl, {
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${requestToken}`,
		},
	});
	return match(github.status)
		.when(
			(status) => status >= 200 && status < 300,
			async () =>
				match(await github.json())
					.with({ value: P.string.minLength(1) }, ({ value }) => value)
					.otherwise(() => {
						throw new Error('GitHub OIDC token request missing value');
					}),
		)
		.otherwise(() => {
			throw new Error(`GitHub OIDC token request failed (${github.status})`);
		});
}

export async function npmOidcPublishToken(
	packageName: string,
	environ: NodeJS.ProcessEnv,
	registry: string = NPM_REGISTRY,
): Promise<string> {
	return match({
		requestUrl: environ['ACTIONS_ID_TOKEN_REQUEST_URL'],
		requestToken: environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN'],
	})
		.with(
			{ requestUrl: P.string.minLength(1), requestToken: P.string.minLength(1) },
			async ({ requestUrl, requestToken }) => {
				const idToken = await githubActionsIdToken(requestUrl, requestToken, registry);
				const result = await npmRegistryClient(registry, idToken).post({
					throwOnError: false,
					url: `/-/npm/v1/oidc/token/exchange/package${escapedPackagePath(packageName)}`,
					security: [{ key: 'oidcIdToken', scheme: 'bearer', type: 'http' }],
				});
				return match(result)
					.with(
						{ response: { status: P.union(200, 201) }, data: { token: P.string.minLength(1) } },
						({ data }) => data.token,
					)
					.with({ response: { status: P.number } }, ({ response, error }) =>
						httpStatusError(
							'npm OIDC token exchange failed',
							response.status,
							match(error)
								.with(P.string, (text) => text)
								.with({ error: P.string }, ({ error: text }) => text)
								.otherwise(() => ''),
						),
					)
					.otherwise(() => {
						throw new Error('npm OIDC token exchange missing token');
					});
			},
		)
		.otherwise(() => {
			throw new Error(
				'OIDC publish needs ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN',
			);
		});
}
