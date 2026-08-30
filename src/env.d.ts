declare namespace NodeJS {
	interface ProcessEnv {
		PATH?: string;
		HOME?: string;
		TMPDIR?: string;
		CI?: string;
		GITHUB_ACTIONS?: string;
		GITHUB_ENV?: string;
	}
}
