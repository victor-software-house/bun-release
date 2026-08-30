import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env, stdout } from 'node:process';
import { thisCommitBumpedVersion } from '@release/git';
import { registryHasVersion } from '@release/registry';
import { $ } from 'bun';

async function waitForRegistryVersion(
	name: string,
	version: string,
	remaining: number,
): Promise<void> {
	if (await registryHasVersion(name, version)) {
		return;
	}
	if (remaining === 0) {
		throw new Error(`npm registry did not observe ${name}@${version}`);
	}
	await Bun.sleep(5_000);
	return waitForRegistryVersion(name, version, remaining - 1);
}

export async function publishIfNeeded(name: string, version: string): Promise<void> {
	const specifier = `${name}@${version}`;
	if (!(await thisCommitBumpedVersion(version))) {
		stdout.write(`skip publish: HEAD did not bump package.json (${specifier})\n`);
		return;
	}
	if (await registryHasVersion(name, version)) {
		stdout.write(`skip publish: ${specifier} is already on npm\n`);
		return;
	}
	await $`bun publish --access public --tolerate-republish`;
	await waitForRegistryVersion(name, version, 11);
	const installDir = await mkdtemp(join(tmpdir(), 'bun-release-smoke-'));
	const cacheDir = await mkdtemp(join(tmpdir(), 'bun-release-cache-'));
	await $`bun add ${specifier}`.cwd(installDir).env({
		...env,
		BUN_INSTALL_CACHE_DIR: cacheDir,
		HOME: installDir,
	});
	await $`node --input-type=module -e ${`import ${JSON.stringify(name)}`}`.cwd(installDir);
	stdout.write(`published and smoked ${specifier}\n`);
}
