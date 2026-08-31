import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
	},
	format: 'esm',
	platform: 'node',
	target: 'node26',
	fixedExtension: false,
	sourcemap: true,
	clean: true,
	hash: false,
	unbundle: true,
	dts: { tsconfig: 'tsconfig.build.json' },
	failOnWarn: 'ci-only',
	suppressWarnings: [
		'TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.',
	],
	deps: {
		neverBundle: ['bun'],
		onlyBundle: [],
		onlyImport: ['ts-pattern', 'bun', 'p-retry', 'zod', 'ky'],
	},
});
