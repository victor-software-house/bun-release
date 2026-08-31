import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packPublishDocument } from 'bun-release';
import { match, P } from 'ts-pattern';

test('publish document nests dist on the version, not the packument root', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'bun-release-pack-'));
	writeFileSync(
		join(directory, 'package.json'),
		JSON.stringify({
			name: '@victor-software-house/pack-fixture',
			version: '0.0.0',
			description: 'fixture',
			files: ['index.js'],
		}),
	);
	writeFileSync(join(directory, 'index.js'), 'export {}\n');
	const packDir = mkdtempSync(join(tmpdir(), 'bun-release-tgz-'));
	const { document } = await packPublishDocument(
		{
			name: '@victor-software-house/pack-fixture',
			version: '0.0.0',
			directory,
		},
		packDir,
		'public',
		'https://registry.npmjs.org/',
	);
	const filename = '@victor-software-house/pack-fixture-0.0.0.tgz';
	expect(
		match(document)
			.with(
				{
					_id: '@victor-software-house/pack-fixture',
					name: '@victor-software-house/pack-fixture',
					description: 'fixture',
					'dist-tags': { latest: '0.0.0' },
					access: 'public',
					versions: {
						'0.0.0': {
							_id: '@victor-software-house/pack-fixture@0.0.0',
							name: '@victor-software-house/pack-fixture',
							version: '0.0.0',
							dist: {
								integrity: P.string.startsWith('sha512-'),
								shasum: P.string.minLength(40),
								tarball:
									'http://registry.npmjs.org/@victor-software-house/pack-fixture/-/@victor-software-house/pack-fixture-0.0.0.tgz',
							},
						},
					},
					_attachments: {
						[filename]: {
							content_type: 'application/octet-stream',
							data: P.string.minLength(1),
							length: P.number.gt(0),
						},
					},
				},
				() => true,
			)
			.otherwise(() => document),
	).toBe(true);
	expect(document).not.toHaveProperty('dist');
});
