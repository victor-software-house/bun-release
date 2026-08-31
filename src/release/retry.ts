import type { Options } from 'p-retry';
import pRetry from 'p-retry';

export type RetryOptions = Required<
	Pick<Options, 'retries' | 'minTimeout' | 'maxTimeout' | 'factor' | 'randomize' | 'maxRetryTime'>
> &
	Pick<Options, 'onFailedAttempt' | 'signal'>;

export const publishRetry: RetryOptions = {
	retries: 10,
	minTimeout: 1_000,
	maxTimeout: 20_000,
	factor: 2,
	randomize: true,
	maxRetryTime: 90_000,
};

export const bootstrapVisibilityRetry: RetryOptions = {
	retries: 100,
	minTimeout: 2_000,
	maxTimeout: 20_000,
	factor: 1.5,
	randomize: true,
	maxRetryTime: 10 * 60_000,
};

const LOGIN_MIN_TIMEOUT = 1_000;
const LOGIN_MAX_RETRY_TIME = 20 * 60_000;

export const loginRetry: RetryOptions = {
	retries: Math.ceil(LOGIN_MAX_RETRY_TIME / LOGIN_MIN_TIMEOUT),
	minTimeout: LOGIN_MIN_TIMEOUT,
	maxTimeout: LOGIN_MIN_TIMEOUT,
	factor: 1,
	randomize: false,
	maxRetryTime: LOGIN_MAX_RETRY_TIME,
};

export function retry<Value>(
	operation: () => Promise<Value>,
	options: RetryOptions = publishRetry,
): Promise<Value> {
	return pRetry(operation, options);
}
