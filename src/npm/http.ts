import { match, P } from 'ts-pattern';

export type BearerJsonHeaders = {
	Accept: string;
	Authorization: string;
	'Content-Type': string;
};

export type NpmPublishHeaders = BearerJsonHeaders & {
	'npm-auth-type': 'web';
	'npm-command': 'publish';
	'npm-otp'?: string;
};

export function httpStatusError(action: string, status: number, detail: string): never {
	throw new Error(
		match(detail.trim())
			.with('', () => `${action} (${status})`)
			.otherwise((text) => `${action} (${status}): ${text}`),
	);
}

export async function httpError(action: string, response: Response): Promise<never> {
	httpStatusError(action, response.status, await response.text());
}

export function bearerHeaders(token: string): BearerJsonHeaders {
	return {
		Accept: 'application/json',
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json',
	};
}

export function npmPublishHeaders(token: string, otp?: string): NpmPublishHeaders {
	return match(otp)
		.returnType<NpmPublishHeaders>()
		.with(P.string.minLength(1), (headerOtp) => ({
			...bearerHeaders(token),
			'npm-auth-type': 'web',
			'npm-command': 'publish',
			'npm-otp': headerOtp,
		}))
		.otherwise(() => ({
			...bearerHeaders(token),
			'npm-auth-type': 'web',
			'npm-command': 'publish',
		}));
}
