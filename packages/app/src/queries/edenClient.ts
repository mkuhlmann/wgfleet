import { useAuthStore } from '@app/stores/auth';
import { treaty } from '@elysiajs/eden';
import type { App } from '@server/index';
import type { Failure } from '@server/lib/failure';

/**
 * A failed request, with the structure the server sent rather than a flattened string.
 *
 * `field` names the request property the server refused, spelled exactly as the form spells it
 * (see server/src/lib/failure.ts), which is what lets a modal put the message on the input that
 * caused it. It used to be lost at the seam: every domain refusal arrived as bare text, so the
 * peer form assigned all of them to the same input.
 */
export class ApiError extends Error {
	readonly field?: string;
	readonly status: number;

	constructor(failure: Failure, status: number) {
		super(failure.message);
		this.name = 'ApiError';
		this.field = failure.field;
		this.status = status;
	}
}

/**
 * Every error body is json with a `message` - ours (server/src/api/failure.ts) and Elysia's own
 * schema violations alike, the latter naming the offending property rather than a form field.
 * One decode, not three guesses at which of three shapes arrived.
 */
const decodeFailure = async (response: Response): Promise<Failure> => {
	try {
		const json = (await response.clone().json()) as { message?: string; field?: string; property?: string };
		if (json?.message) return { message: json.message, field: json.field ?? json.property?.replace(/^\//, '') };
	} catch {
		// not json at all - fall through to the raw body
	}

	return { message: (await response.clone().text()) || response.statusText };
};

export const eden = treaty<App>(`${location.origin}`, {
	headers(path, options) {
		const authStore = useAuthStore();
		if (authStore.authTokenValidated) {
			return {
				authorization: `Bearer ${authStore.authToken}`,
			};
		}
	},
	// Throws rather than returning eden's `{ data, error }` union, so every call site can read
	// `.data` directly and no call site can forget to check `.error` - see useWrite.ts, which is
	// where a thrown ApiError is turned back into something the operator sees.
	fetcher: (async (url, options) => {
		const response = await fetch(url, options);
		if (response.status >= 400) {
			throw new ApiError(await decodeFailure(response), response.status);
		}
		return response;
	}) as typeof fetch,
});

export const api = eden.api.v1;
