import pRetry from 'p-retry';

export type RetryOptions = {
	retries: number;
	minTimeout: number;
	maxTimeout: number;
	factor: number;
	randomize: boolean;
	maxRetryTime: number;
};

export const publishRetry: RetryOptions = {
	retries: 10,
	minTimeout: 1_000,
	maxTimeout: 20_000,
	factor: 2,
	randomize: true,
	maxRetryTime: 90_000,
};

export const loginRetry: RetryOptions = {
	...publishRetry,
	retries: 60,
	factor: 1,
	randomize: false,
	maxRetryTime: 5 * 60_000,
};

export function retry<Value>(
	operation: () => Promise<Value>,
	options: RetryOptions = publishRetry,
): Promise<Value> {
	return pRetry(operation, options);
}
