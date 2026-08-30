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
	deps: {
		onlyBundle: [],
		onlyImport: ['ts-pattern', 'bun'],
	},
});
