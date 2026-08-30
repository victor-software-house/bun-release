import { describe, expect, test } from 'bun:test';
import { changelogSection } from 'bun-release';

describe('changelogSection', () => {
	test('returns the body under the version heading', () => {
		const changelog = `# Changelog

## 0.0.1

Patch notes.

## 0.0.0

Bootstrap.
`;
		expect(changelogSection(changelog, '0.0.1')).toBe('Patch notes.');
	});

	test('throws when the heading is missing', () => {
		expect(() => changelogSection('# Changelog\n\n## 0.0.0\n\nBootstrap.\n', '1.0.0')).toThrow(
			'No CHANGELOG.md section found for 1.0.0',
		);
	});

	test('throws when the section is empty', () => {
		expect(() =>
			changelogSection('# Changelog\n\n## 0.0.0\n\n## 0.0.1\n\nLater.\n', '0.0.0'),
		).toThrow('No CHANGELOG.md section found for 0.0.0');
	});
});
