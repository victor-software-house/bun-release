export function changelogSection(changelog: string, version: string): string {
	const heading = `## ${version}`;
	const lines = changelog.split(/\r?\n/);
	const start = lines.indexOf(heading);
	if (start === -1) {
		throw new Error(`No CHANGELOG.md section found for ${version}`);
	}
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => line.startsWith('## '));
	const section = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
	if (section === '') {
		throw new Error(`No CHANGELOG.md section found for ${version}`);
	}
	return section;
}
