import { useAuthStore } from '@app/stores/auth';
import { treaty, type Treaty } from '@elysiajs/eden';
import type { App } from '@server/index';

export const eden = treaty<App>(`${location.origin}`, {
	headers(path, options) {
		const authStore = useAuthStore();
		if (authStore.authTokenValidated) {
			return {
				authorization: `Bearer ${authStore.authToken}`,
			};
		}
	},
	fetcher: (async (url, options) => {
		const response = await fetch(url, options);
		if (response.status >= 400) {
			const clone = response.clone();
			const isJson = clone.headers.get('content-type')?.includes('application/json');

			if (isJson) {
				const json = await clone.json();
				if (json.property) {
					throw new Error(`${json.property}: ${json.message}`);
				}
				throw new Error(json.message);
			} else {
				const text = await clone.text();
				throw new Error(text);
			}
		}
		return response;
	}) as typeof fetch,
});

export const api = eden.api.v1;
