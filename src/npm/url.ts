import { match } from 'ts-pattern';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const NPM_REGISTRY_HOST = 'registry.npmjs.org';

export type NpmAccess = 'public' | 'restricted';

export function trailingSlash(registry: string): string {
	return match(registry.endsWith('/'))
		.with(true, () => registry)
		.with(false, () => `${registry}/`)
		.exhaustive();
}

export function registryPath(registry: string, path: string): URL {
	return new URL(path, trailingSlash(registry));
}

export function escapedPackageName(name: string): string {
	return name.replace('/', '%2f');
}

/** Path pnpm 12 PUT/GET: `/@scope%2fname`, not encodeURIComponent of the whole name. */
export function escapedPackagePath(name: string): string {
	return `/${escapedPackageName(name)}`;
}

export function packumentUrl(registry: string, name: string): URL {
	return new URL(`${trailingSlash(registry)}${escapedPackageName(name)}`);
}

export function packagePutUrl(registry: string, name: string): URL {
	return packumentUrl(registry, name);
}

export function isHttpUrl(value: string): boolean {
	try {
		return match(new URL(value).protocol)
			.with('https:', () => true)
			.with('http:', () => true)
			.otherwise(() => false);
	} catch {
		return false;
	}
}

export function rewriteRegistryDoneUrl(doneUrl: string, registry: string): string {
	const done = new URL(doneUrl);
	return match(done.hostname)
		.with(NPM_REGISTRY_HOST, () => {
			const origin = new URL(trailingSlash(registry));
			done.protocol = origin.protocol;
			done.host = origin.host;
			const prefix = origin.pathname.replace(/\/$/, '');
			const prefixed =
				prefix === '' ||
				prefix === '/' ||
				done.pathname === prefix ||
				done.pathname.startsWith(`${prefix}/`);
			return match(prefixed)
				.with(true, () => done.href)
				.with(false, () => {
					done.pathname = `${prefix}${done.pathname}`;
					return done.href;
				})
				.exhaustive();
		})
		.otherwise(() => doneUrl);
}
