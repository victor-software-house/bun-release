import { describe, expect, test } from 'bun:test';
import { peeledTagSha } from 'bun-release';

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
});
