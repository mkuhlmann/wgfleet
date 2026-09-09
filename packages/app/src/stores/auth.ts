import { api } from '@app/queries/edenClient';
import { defineStore } from 'pinia';
import { ref } from 'vue';

const STORAGE_KEY = 'wg_session_token';
const STORAGE_EXPIRY_KEY = 'wg_session_expires';

export const useAuthStore = defineStore('authStore', () => {
	const authToken = ref<string | null>(null);
	const authTokenValidated = ref<boolean>(false);

	async function login(token: string, remember: boolean = true) {
		const cleanToken = token.trim();
		try {
			const resp = await api.auth.login.post({
				token: cleanToken,
				remember,
			});

			if (resp.error) {
				throw resp.error.value;
			}

			const sessionToken = resp.data.token;
			const rawExpiresAt = resp.data.expiresAt;
			const expiresAt = typeof rawExpiresAt === 'string' ? rawExpiresAt : new Date(rawExpiresAt).toISOString();

			authToken.value = sessionToken;
			authTokenValidated.value = true;

			if (remember) {
				localStorage.setItem(STORAGE_KEY, sessionToken);
				localStorage.setItem(STORAGE_EXPIRY_KEY, expiresAt);
				sessionStorage.removeItem(STORAGE_KEY);
				sessionStorage.removeItem(STORAGE_EXPIRY_KEY);
			} else {
				sessionStorage.setItem(STORAGE_KEY, sessionToken);
				sessionStorage.setItem(STORAGE_EXPIRY_KEY, expiresAt);
				localStorage.removeItem(STORAGE_KEY);
				localStorage.removeItem(STORAGE_EXPIRY_KEY);
			}

			return true;
		} catch (err) {
			clearLocalSession();
			throw err;
		}
	}

	function clearLocalSession() {
		authToken.value = null;
		authTokenValidated.value = false;
		localStorage.removeItem(STORAGE_KEY);
		localStorage.removeItem(STORAGE_EXPIRY_KEY);
		sessionStorage.removeItem(STORAGE_KEY);
		sessionStorage.removeItem(STORAGE_EXPIRY_KEY);
	}

	async function logout() {
		try {
			if (authToken.value) {
				await api.auth.logout.post();
			}
		} catch {
			// ignore network error on logout
		} finally {
			clearLocalSession();
		}
	}

	function clearAuthToken() {
		clearLocalSession();
	}

	async function isAuthenticated() {
		if (authToken.value !== null && authTokenValidated.value) {
			return true;
		}

		// Try restoring from storage (localStorage first, then sessionStorage)
		let storedToken = localStorage.getItem(STORAGE_KEY);
		let storedExpiry = localStorage.getItem(STORAGE_EXPIRY_KEY);

		if (!storedToken) {
			storedToken = sessionStorage.getItem(STORAGE_KEY);
			storedExpiry = sessionStorage.getItem(STORAGE_EXPIRY_KEY);
		}

		if (storedToken) {
			// Fast check if locally recorded expiration is in the past
			if (storedExpiry) {
				const expiryTime = new Date(storedExpiry).getTime();
				if (!isNaN(expiryTime) && expiryTime <= Date.now()) {
					clearLocalSession();
					return false;
				}
			}

			try {
				const verifyRes = await api.auth.verify.get({
					headers: {
						authorization: `Bearer ${storedToken}`,
					},
				});
				if (verifyRes.error) {
					clearLocalSession();
					return false;
				}
				authToken.value = storedToken;
				authTokenValidated.value = true;
				return true;
			} catch {
				clearLocalSession();
				return false;
			}
		}

		return false;
	}

	return {
		authToken,
		authTokenValidated,
		login,
		logout,
		clearAuthToken,
		isAuthenticated,
	};
});
