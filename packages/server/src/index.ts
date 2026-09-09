import { Elysia } from 'elysia';
import swagger from '@elysiajs/swagger';
import staticPlugin from '@elysiajs/static';
import { createLog } from './lib/log';
import { auth, authRoutes } from './api/auth';
import { serversRoutes } from './api/servers';
import { peersRoutes } from './api/peers';
import { wgManager } from './wg/manager';
import { serversPeersRoute } from './api/serversPeers';
import { policyRoutes } from './api/policy';
import { trafficRoutes } from './api/traffic';
import { migrateDb } from './db';
import { nanoid } from 'nanoid';

const httpLog = createLog('http');
const log = createLog('core');

const _app = new Elysia()
	.use(
		swagger({
			documentation: {
				info: {
					title: 'wgfleet',
					version: '1.0.0',
				},
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
						},
					},
				},
			},
		})
	)
	.onBeforeHandle(({ request, server }) => {
		httpLog.info(`${request.method} ${request.url} ${server?.requestIP(request)?.address}`);
	})
	.use(auth)
	.group('/api/v1', (app) => app.use(authRoutes).use(serversRoutes).use(serversPeersRoute).use(peersRoutes).use(policyRoutes).use(trafficRoutes))
	.use(
		staticPlugin({
			indexHTML: true,
			assets: '../app/dist',
			prefix: '',
		})
	)
	.onError(({ code, status, request }) => {
		if (code == 'NOT_FOUND' && request.method == 'GET' && !request.url.startsWith('/api/')) {
			return Bun.file('../app/dist/index.html');
			return;
		}
		httpLog.error(`${code} on ${request.method} ${request.url}`);
	});

const main = async () => {
	if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 16) {
		log.warn('ADMIN_TOKEN is not set or too short, generating temporary token');
		process.env.ADMIN_TOKEN = nanoid(32);
		log.info(`Generated token: ${process.env.ADMIN_TOKEN}`);
	}

	log.info('Migrating database');
	await migrateDb();

	log.info('Starting wireguard manager');
	wgManager.start();

	const port = Number(process.env.PORT) || 3000;
	log.info(`Starting http server on port ${port}`);
	_app.listen({ port, hostname: '0.0.0.0' });

	httpLog.info(`api ist running at ${_app.server?.hostname}:${_app.server?.port}`);
};

let stopping = false;

const exit = async () => {
	if (stopping) return;
	stopping = true;
	log.info('Stopping wireguard manager');
	await wgManager.stop();

	process.exit();
};

process.on('SIGINT', exit);
process.on('SIGTERM', exit);
process.on('beforeExit', exit);

main();

export type App = typeof _app;
