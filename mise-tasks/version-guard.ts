#!/usr/bin/env bun
//MISE description="Block local package.json version drift from origin/main"

import { env, exit, stderr } from 'node:process';
import { match, P } from 'ts-pattern';

if (env['CI'] === 'true') {
	exit(0);
}

const branchProc = Bun.spawnSync({
	cmd: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
	stdout: 'pipe',
});
const branch = branchProc.stdout.toString().trim();
if (branch.startsWith('changeset-release/')) {
	exit(0);
}

Bun.spawnSync({
	cmd: ['git', 'fetch', 'origin', 'main', '--quiet'],
	stderr: 'ignore',
});

const filesProc = Bun.spawnSync({
	cmd: ['git', 'ls-files', 'package.json', '*/package.json'],
	stdout: 'pipe',
});
const files = filesProc.stdout
	.toString()
	.split('\n')
	.filter((line) => line !== '');

let errors = 0;
for (const file of files) {
	const remote = Bun.spawnSync({
		cmd: ['git', 'show', `origin/main:${file}`],
		stdout: 'pipe',
		stderr: 'ignore',
	});
	if (remote.exitCode !== 0) {
		continue;
	}
	const remoteVersion = packageVersion(remote.stdout.toString());
	const localVersion = packageVersion(await Bun.file(file).text());
	if (remoteVersion !== undefined && remoteVersion !== localVersion) {
		stderr.write(`BLOCKED: ${file} version changed locally (${remoteVersion} → ${localVersion})\n`);
		stderr.write('  Versions are CI-managed via changesets.\n');
		errors += 1;
	}
}

if (errors > 0) {
	exit(1);
}

function packageVersion(text: string): string | undefined {
	try {
		return match(JSON.parse(text))
			.with({ version: P.string }, ({ version }) => version)
			.otherwise(() => undefined);
	} catch {
		return undefined;
	}
}
