import { $ } from 'bun';
import { match, P } from 'ts-pattern';

export async function thisCommitBumpedVersion(version: string): Promise<boolean> {
	const shown = await $`git show ${'HEAD^:package.json'}`.nothrow().quiet();
	if (shown.exitCode !== 0) {
		return false;
	}
	return match(JSON.parse(shown.stdout.toString()))
		.with({ version: P.string }, ({ version: parent }) => parent !== version)
		.otherwise(() => false);
}

type TagRow = {
	ref: string;
	sha: string;
};

function tagRow(line: string): TagRow | undefined {
	const [sha, ref] = line.split('\t');
	return match({ ref, sha })
		.with({ ref: P.string.minLength(1), sha: P.string.minLength(1) }, (row) => row)
		.otherwise(() => undefined);
}

export function peeledTagSha(lsRemote: string, tag: string): string | undefined {
	const suffix = `refs/tags/${tag}`;
	const peeledSuffix = `${suffix}^{}`;
	const rows = lsRemote.split('\n').flatMap((line) => {
		const row = tagRow(line);
		return row === undefined ? [] : [row];
	});
	return (
		rows.find((row) => row.ref === peeledSuffix)?.sha ?? rows.find((row) => row.ref === suffix)?.sha
	);
}
