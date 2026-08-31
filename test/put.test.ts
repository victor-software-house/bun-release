import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packPublishDocument, putNpmPackage } from 'bun-release';

let stop: (() => void) | undefined;

afterEach(() => {
	stop?.();
	stop = undefined;
});

test('PUT uses /@scope%2fname with no access query', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'bun-release-put-'));
	writeFileSync(
		join(directory, 'package.json'),
		JSON.stringify({
			name: '@victor-software-house/pack-fixture',
			version: '0.0.0',
			files: ['index.js'],
		}),
	);
	writeFileSync(join(directory, 'index.js'), 'export {}\n');
	const packDir = mkdtempSync(join(tmpdir(), 'bun-release-put-tgz-'));
	const packed = await packPublishDocument(
		{
			name: '@victor-software-house/pack-fixture',
			version: '0.0.0',
			directory,
		},
		packDir,
	);
	const seen: string[] = [];
	const agents: string[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			seen.push(`${url.pathname}${url.search}`);
			agents.push(request.headers.get('user-agent') ?? '');
			return new Response(null, { status: 201 });
		},
	});
	stop = () => {
		void server.stop(true);
	};
	await putNpmPackage({
		registry: `http://127.0.0.1:${server.port}/`,
		document: packed,
		token: 'session',
		access: 'public',
	});
	expect(seen).toEqual(['/@victor-software-house%2fpack-fixture']);
	expect(agents[0]).toMatch(/^bun-release\/\d+\.\d+\.\d+/);
});
