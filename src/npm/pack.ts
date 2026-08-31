import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PublishDocument } from '@release/generated/types.gen';
import { PublishDocumentSchema, VersionManifestSchema } from '@release/generated/zod.gen';
import type { NpmAccess } from '@release/npm/url';
import { escapedPackageName, NPM_REGISTRY, trailingSlash } from '@release/npm/url';
import { $ } from 'bun';
import { match, P } from 'ts-pattern';
import * as z from 'zod';

export type PackedDirectory = {
	name: string;
	version: string;
	directory: string;
};

export type PackedPublish = {
	name: string;
	version: string;
	document: PublishDocument;
};

const PackedPublishDocumentSchema = PublishDocumentSchema.extend({
	versions: z.record(z.string(), VersionManifestSchema.loose()),
});

function sha1Hex(bytes: Uint8Array): string {
	return createHash('sha1').update(bytes).digest('hex');
}

function sha512Integrity(bytes: Uint8Array): string {
	return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function localTarballPath(packDir: string, name: string, version: string): string {
	return join(packDir, `${escapedPackageName(name).replace('%2f', '-')}-${version}.tgz`);
}

function attachmentName(name: string, version: string): string {
	return `${name}-${version}.tgz`;
}

function tarballUrl(registry: string, name: string, filename: string): string {
	return new URL(`${name}/-/${filename}`, trailingSlash(registry)).href.replace(
		'https://',
		'http://',
	);
}

export async function packPublishDocument(
	pkg: PackedDirectory,
	packDir: string,
	access: NpmAccess = 'public',
	registry: string = NPM_REGISTRY,
): Promise<PackedPublish> {
	const tarball = localTarballPath(packDir, pkg.name, pkg.version);
	await $`bun pm pack --filename ${tarball} --ignore-scripts --quiet`.cwd(pkg.directory).quiet();
	const manifest: unknown = JSON.parse(
		await readFile(join(pkg.directory, 'package.json'), { encoding: 'utf8' }),
	);
	const { name, version, description } = match(manifest)
		.with(
			{ name: P.string.minLength(1), version: P.string.minLength(1), description: P.string },
			(row) => ({ name: row.name, version: row.version, description: row.description }),
		)
		.with({ name: P.string.minLength(1), version: P.string.minLength(1) }, (row) => ({
			name: row.name,
			version: row.version,
			description: undefined,
		}))
		.otherwise(() => {
			throw new Error(`package.json in ${pkg.directory} must have name and version`);
		});
	match({ name, version })
		.with({ name: pkg.name, version: pkg.version }, () => undefined)
		.otherwise(() => {
			throw new Error(
				`package.json in ${pkg.directory} is ${name}@${version}, expected ${pkg.name}@${pkg.version}`,
			);
		});
	const tarBytes = await readFile(tarball);
	const filename = attachmentName(name, version);
	const dist = {
		integrity: sha512Integrity(tarBytes),
		shasum: sha1Hex(tarBytes),
		tarball: tarballUrl(registry, name, filename),
	};
	const versionManifest = match(manifest)
		.with(P.record(P.string, P.unknown), (row) => ({
			...row,
			_id: `${name}@${version}`,
			version,
			dist,
		}))
		.otherwise(() => {
			throw new Error(`package.json in ${pkg.directory} must be an object`);
		});
	const candidate = {
		_id: name,
		name,
		'dist-tags': { latest: version },
		versions: { [version]: versionManifest },
		access,
		_attachments: {
			[filename]: {
				content_type: 'application/octet-stream' as const,
				data: tarBytes.toString('base64'),
				length: tarBytes.byteLength,
			},
		},
	};
	const parsed = PackedPublishDocumentSchema.parse(
		match(description)
			.with(P.string, (text) => ({ ...candidate, description: text }))
			.otherwise(() => candidate),
	);
	const { description: parsedDescription, ...rest } = parsed;
	const document: PublishDocument = match(parsedDescription)
		.with(P.string, (text) => ({ ...rest, description: text }))
		.otherwise(() => rest);
	return { name, version, document };
}
