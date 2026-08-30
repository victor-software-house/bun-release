import { appendFile } from 'node:fs/promises';
import { stdout } from 'node:process';
import { match, P } from 'ts-pattern';

export async function writeMaskedGithubEnv(githubEnvPath: string, token: string): Promise<void> {
	return match(githubEnvPath)
		.with(P.string.minLength(1), async (path) => {
			stdout.write(`::add-mask::${token}\n`);
			await appendFile(path, `BUN_CONFIG_TOKEN=${token}\n`);
		})
		.otherwise(() => {
			throw new Error('release:oidc writes BUN_CONFIG_TOKEN to GITHUB_ENV (CI only)');
		});
}
