import { NPM_REGISTRY } from '@release/registry';
import { match, P } from 'ts-pattern';

function npmOidcExchangeUrl(packageName: string, registry: string): URL {
	return new URL(
		`/-/npm/v1/oidc/token/exchange/package/${packageName.replace('/', '%2F')}`,
		registry,
	);
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
				const githubUrl = new URL(requestUrl);
				githubUrl.searchParams.set('audience', `npm:${new URL(registry).hostname}`);
				const github = await fetch(githubUrl, {
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${requestToken}`,
					},
				});
				if (!github.ok) {
					throw new Error(`GitHub OIDC token request failed (${github.status})`);
				}
				const githubBody: unknown = await github.json();
				const idToken = match(githubBody)
					.with({ value: P.string.minLength(1) }, ({ value }) => value)
					.otherwise(() => {
						throw new Error('GitHub OIDC token request missing value');
					});

				const exchange = await fetch(npmOidcExchangeUrl(packageName, registry), {
					method: 'POST',
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${idToken}`,
					},
				});
				if (!exchange.ok) {
					throw new Error(`npm OIDC token exchange failed (${exchange.status})`);
				}
				const exchangeBody: unknown = await exchange.json();
				return match(exchangeBody)
					.with({ token: P.string.minLength(1) }, ({ token }) => token)
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
