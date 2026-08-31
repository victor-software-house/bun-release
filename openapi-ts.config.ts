import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
	input: './vendor/npm-registry.yaml',
	output: {
		header: (ctx) => ['// @ts-nocheck', ...ctx.defaultValue],
		path: 'src/generated',
		module: {
			resolve: (specifier) => {
				if (!specifier.startsWith('./')) {
					return undefined;
				}
				return `@release/generated/${specifier.slice(2)}`;
			},
		},
		postProcess: [
			{
				command: 'oxlint',
				args: ['--fix', '{{path}}'],
				name: 'oxlint',
			},
			{
				command: 'biome',
				args: ['check', '--write', '--unsafe', '{{path}}'],
				name: 'Biome (Check)',
			},
		],
	},
	plugins: [
		'@hey-api/typescript',
		{
			name: '@hey-api/client-ky',
			throwOnError: true,
		},
		{
			name: '@hey-api/sdk',
			responseStyle: 'fields',
			validator: true,
		},
		{
			name: 'zod',
			definitions: {
				case: 'PascalCase',
				name: '{{name}}Schema',
			},
			requests: {
				case: 'PascalCase',
				body: {
					case: 'PascalCase',
					name: '{{name}}BodySchema',
					types: {
						input: {
							case: 'PascalCase',
							name: '{{name}}Body',
						},
					},
				},
				headers: { case: 'PascalCase', name: '{{name}}HeadersSchema' },
				path: { case: 'PascalCase', name: '{{name}}PathSchema' },
				query: { case: 'PascalCase', name: '{{name}}QuerySchema' },
			},
			responses: {
				case: 'PascalCase',
				name: '{{name}}ResponseSchema',
			},
		},
	],
});
