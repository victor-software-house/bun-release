import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { peeledTagSha, remoteTagSha } from 'bun-release';

describe('peeledTagSha', () => {
	test('prefers the peeled annotated-tag object', () => {
		const lsRemote = [
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v0.0.1',
			'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v0.0.1^{}',
			'',
		].join('\n');
		expect(peeledTagSha(lsRemote, 'v0.0.1')).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
	});

	test('falls back to the direct tag ref', () => {
		const lsRemote = 'cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v0.0.0\n';
		expect(peeledTagSha(lsRemote, 'v0.0.0')).toBe('cccccccccccccccccccccccccccccccccccccccc');
	});

	test('returns undefined when the tag is absent', () => {
		expect(peeledTagSha('', 'v0.0.0')).toBeUndefined();
	});

	test('reads the peeled commit from an annotated remote tag', async () => {
		const root = await mkdtemp(join(tmpdir(), 'bun-release-tag-'));
		const remote = join(root, 'remote.git');
		const repo = join(root, 'repo');
		await $`git init --bare ${remote}`.quiet();
		await $`git init ${repo}`.quiet();
		await Bun.write(join(repo, 'file.txt'), 'tag target\n');
		await $`git add file.txt`.cwd(repo).quiet();
		await $`git -c user.name=Test -c user.email=test@example.com commit -m initial`
			.cwd(repo)
			.quiet();
		const sha = (await $`git rev-parse HEAD`.cwd(repo).text()).trim();
		await $`git -c user.name=Test -c user.email=test@example.com tag -a v0.0.1 -m v0.0.1`
			.cwd(repo)
			.quiet();
		await $`git push ${remote} v0.0.1`.cwd(repo).quiet();
		expect(await remoteTagSha(remote, 'v0.0.1')).toBe(sha);
	});
});
