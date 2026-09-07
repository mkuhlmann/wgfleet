import { fileURLToPath, URL } from 'node:url';

import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueDevTools from 'vite-plugin-vue-devtools';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
	const serverEnv = loadEnv(mode, fileURLToPath(new URL('../server', import.meta.url)), '');
	const rootEnv = loadEnv(mode, fileURLToPath(new URL('../../', import.meta.url)), '');
	const port = process.env.PORT || serverEnv.PORT || rootEnv.PORT || '3000';

	return {
		plugins: [vue(), vueDevTools(), tailwindcss()],
		resolve: {
			alias: {
				'@app': fileURLToPath(new URL('./src', import.meta.url)),
			},
		},
		server: {
			proxy: {
				'/api': `http://localhost:${port}`,
			},
		},
	};
});
