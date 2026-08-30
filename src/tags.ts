import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env, stdout } from 'node:process';
import { changelogSection } from '@release/changelog';
import { peeledTagSha, thisCommitBumpedVersion } from '@release/git';
import { $ } from 'bun';

export async function tagAndGithubRelease(version: string): Promise<void> {
	const tag = `v${version}`;
	if (!(await thisCommitBumpedVersion(version))) {
		stdout.write(`skip tags: HEAD did not bump package.json (${tag})\n`);
		return;
	}

	const sha = (await $`git rev-parse HEAD`.text()).trim();
	const refspec = `refs/tags/${tag}:refs/tags/${tag}`;

	if (env['GITHUB_ACTIONS'] === 'true') {
		await $`git config user.name ${'github-actions[bot]'}`;
		await $`git config user.email ${'41898282+github-actions[bot]@users.noreply.github.com'}`;
	}

	const remote = await $`git ls-remote --tags origin ${tag}`.text();
	const remoteSha = peeledTagSha(remote, tag);
	if (remoteSha === undefined) {
		await $`git tag -a ${tag} ${sha} -m ${tag}`;
		await $`git push origin ${refspec}`;
		const verified = await $`git ls-remote --tags origin ${tag}`.text();
		const verifiedSha = peeledTagSha(verified, tag);
		if (verifiedSha !== sha) {
			throw new Error(
				`tag ${tag} on origin is ${verifiedSha ?? 'missing'}, expected commit ${sha}`,
			);
		}
	} else if (remoteSha !== sha) {
		throw new Error(`tag ${tag} on origin is ${remoteSha}, expected commit ${sha}`);
	} else {
		stdout.write(`tag ${tag} already points at ${sha}\n`);
	}

	const existing = await $`gh release view ${tag}`.nothrow().quiet();
	if (existing.exitCode === 0) {
		stdout.write(`GitHub Release ${tag} already exists\n`);
		return;
	}

	const notes = changelogSection(await Bun.file('CHANGELOG.md').text(), version);
	const notesDir = await mkdtemp(join(tmpdir(), 'bun-release-notes-'));
	const notesFile = join(notesDir, 'notes.md');
	await Bun.write(notesFile, notes);
	await $`gh release create ${tag} --title ${tag} --notes-file ${notesFile} --target ${sha}`;
	stdout.write(`created GitHub Release ${tag}\n`);
}
