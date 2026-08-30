import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCommitInfo } from '@changesets/get-github-info';
import type {
	ChangelogFunctions,
	GetDependencyReleaseLine,
	GetReleaseLine,
} from '@changesets/types';
import { Liquid } from 'liquidjs';
import { match, P } from 'ts-pattern';

type PullRequest = {
	number: number;
	url: string;
	user: string | null;
	userUrl: string | null;
};

/**
 * The commit that introduced the changeset.
 *
 * Only used when no PR is associated. A direct push to the base branch has no PR
 * for `getCommitInfo` to find, and an entry with neither link is untraceable — which is
 * what the PR-only template produced for every release in a direct-push flow.
 */
type Commit = {
	short: string;
	url: string;
};

type ChangelogOptions = {
	internalAuthors?: string[];
	repo?: string;
};

type ReleaseTemplateData = {
	commit: Commit | null;
	continuations: string[];
	pullRequest: (PullRequest & { externalAuthor: boolean }) | null;
	summary: string;
	summaryHasTerminal: boolean;
};

type DependencyTemplateData = {
	readonly name: string;
	readonly newVersion: string;
};

const releaseTemplatePath = fileURLToPath(new URL('./changelog.liquid', import.meta.url));
const dependencyTemplatePath = fileURLToPath(
	new URL('./dependency-changelog.liquid', import.meta.url),
);
const liquid = new Liquid({
	cache: true,
	strictFilters: true,
	strictVariables: true,
});
const releaseTemplate = liquid.parse(
	readFileSync(releaseTemplatePath, 'utf8'),
	releaseTemplatePath,
);
const dependencyTemplate = liquid.parse(
	readFileSync(dependencyTemplatePath, 'utf8'),
	dependencyTemplatePath,
);

function renderReleaseTemplate(release: ReleaseTemplateData): string {
	return match(liquid.renderSync(releaseTemplate, { release }))
		.with(P.string, (text) => text)
		.otherwise(() => '');
}

function renderDependencyTemplate(dependencies: readonly DependencyTemplateData[]): string {
	return match(liquid.renderSync(dependencyTemplate, { dependencies }))
		.with(P.string, (text) => text)
		.otherwise(() => '');
}

function pullRequestFromCommitInfo(
	info: {
		readonly pull?: { readonly number: number; readonly url: string };
		readonly author?: { readonly login: string; readonly url: string };
	},
	internalAuthors: readonly string[],
): (PullRequest & { externalAuthor: boolean }) | null {
	return match(info.pull)
		.returnType<(PullRequest & { externalAuthor: boolean }) | null>()
		.with(P.nullish, () => null)
		.otherwise((pull) =>
			match(info.author)
				.returnType<PullRequest & { externalAuthor: boolean }>()
				.with({ login: P.string, url: P.string }, ({ login, url }) => ({
					number: pull.number,
					url: pull.url,
					user: login,
					userUrl: url,
					externalAuthor: login !== '' && url !== '' && !internalAuthors.includes(login),
				}))
				.otherwise(() => ({
					number: pull.number,
					url: pull.url,
					user: null,
					userUrl: null,
					externalAuthor: false,
				})),
		);
}

export const getReleaseLine: GetReleaseLine = async (changeset, _type, changelogOpts) => {
	const { internalAuthors = [], repo } = match(changelogOpts)
		.returnType<ChangelogOptions>()
		.with(P.nullish, () => ({}))
		.with({ repo: P.string, internalAuthors: P.array(P.string) }, (value) => ({
			repo: value.repo,
			internalAuthors: value.internalAuthors,
		}))
		.with({ repo: P.string }, (value) => ({ repo: value.repo }))
		.with({ internalAuthors: P.array(P.string) }, (value) => ({
			internalAuthors: value.internalAuthors,
		}))
		.otherwise(() => ({}));
	const [firstLine = '', ...remaining] = changeset.summary
		.split('\n')
		.map((line) => line.trimEnd());

	const linked = await match({ sha: changeset.commit, repo })
		.returnType<
			Promise<{
				commit: Commit | null;
				pullRequest: (PullRequest & { externalAuthor: boolean }) | null;
			}>
		>()
		.with({ sha: P.union(P.nullish, '') }, async () => ({ commit: null, pullRequest: null }))
		.with({ sha: P.string, repo: P.union(P.nullish, '') }, () => {
			throw new Error('options.repo is required for commit-backed releases');
		})
		.with({ sha: P.string, repo: P.string }, async ({ sha, repo: repository }) => {
			const fallbackCommit: Commit = {
				short: sha.slice(0, 7),
				url: `https://github.com/${repository}/commit/${sha}`,
			};
			return match(await getCommitInfo({ repo: repository, commit: sha }))
				.returnType<{
					commit: Commit | null;
					pullRequest: (PullRequest & { externalAuthor: boolean }) | null;
				}>()
				.with(P.nullish, () => ({ commit: fallbackCommit, pullRequest: null }))
				.otherwise((info) => ({
					commit: fallbackCommit,
					pullRequest: pullRequestFromCommitInfo(info, internalAuthors),
				}));
		})
		.exhaustive();

	return renderReleaseTemplate({
		commit: match(linked.pullRequest)
			.with(P.nullish, () => linked.commit)
			.otherwise(() => null),
		continuations: remaining.map((line) => (line === '' ? '' : line.trim())),
		pullRequest: linked.pullRequest,
		summary: match(linked)
			.with({ pullRequest: P.nullish, commit: P.nullish }, () => firstLine)
			.otherwise(() => firstLine.replace(/\.+$/, '')),
		summaryHasTerminal: /[.!?:;]$/.test(firstLine),
	});
};

export const getDependencyReleaseLine: GetDependencyReleaseLine = async (
	_changesets,
	dependenciesUpdated,
	_changelogOpts,
) => {
	if (dependenciesUpdated.length === 0) {
		return '';
	}

	return renderDependencyTemplate(
		dependenciesUpdated.map((dependency) => ({
			name: dependency.name,
			newVersion: dependency.newVersion,
		})),
	);
};

const changelogFunctions: ChangelogFunctions = {
	getReleaseLine,
	getDependencyReleaseLine,
};

export default changelogFunctions;
