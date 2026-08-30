import { match, P } from 'ts-pattern';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';

export async function registryHasVersion(
	name: string,
	version: string,
	registry: string = NPM_REGISTRY,
): Promise<boolean> {
	const response = await fetch(new URL(name.replace('/', '%2F'), registry), {
		headers: { Accept: 'application/vnd.npm.install-v1+json' },
	});
	if (response.status === 404) {
		return false;
	}
	if (!response.ok) {
		throw new Error(`npm registry lookup failed (${response.status}) for ${name}@${version}`);
	}
	const body: unknown = await response.json();
	return match(body)
		.with({ versions: P.record(P.string, P.unknown) }, ({ versions }) => version in versions)
		.otherwise(() => {
			throw new Error(`npm registry packument missing versions for ${name}@${version}`);
		});
}
