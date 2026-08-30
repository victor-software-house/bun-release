import { describe, expect, test } from 'bun:test';
import { changelogSection } from 'bun-release';
import dedent from 'dedent';

describe('changelogSection', () => {
	test('returns the body under the version heading', () => {
		const changelog = dedent`
			# Changelog

			## 0.0.1

			Patch notes.

			## 0.0.0

			Bootstrap.
		`;
		expect(changelogSection(changelog, '0.0.1')).toBe('Patch notes.');
	});

	test('throws when the heading is missing', () => {
		expect(() =>
			changelogSection(
				dedent`
					# Changelog

					## 0.0.0

					Bootstrap.
				`,
				'1.0.0',
			),
		).toThrow('No CHANGELOG.md section found for 1.0.0');
	});

	test('throws when the section is empty', () => {
		expect(() =>
			changelogSection(
				dedent`
					# Changelog

					## 0.0.0

					## 0.0.1

					Later.
				`,
				'0.0.0',
			),
		).toThrow('No CHANGELOG.md section found for 0.0.0');
	});
});
