import { Elysia, status, t } from 'elysia';
import { db } from '../db';
import { serverPeersTable } from '../db/schema';
import IPCIDR from 'ip-cidr';
import { eq, or, and, ne } from 'drizzle-orm';
import { reloadServer, startServer, wgDerivePublicKey, wgGenKey } from '../wg/shell';
import { syncFirewall } from '../wg/firewall';
import { auth } from './auth';
import { createLog } from '@server/lib/log';
import { generateServerConfig } from '@server/wg/config';

const log = createLog('http');

async function isPortInUse(port: number, excludeServerId?: string) {
	const existing = await db.query.serverPeersTable.findFirst({
		where: excludeServerId ? and(eq(serverPeersTable.wgListenPort, port), ne(serverPeersTable.id, excludeServerId)) : eq(serverPeersTable.wgListenPort, port),
	});
	return !!existing;
}

export const serversRoutes = new Elysia()
	.use(auth)
	.get(
		'/wg/servers',
		async () => {
			return db.query.serverPeersTable.findMany();
		},
		{
			verifyAuth: { scope: 'admin' },
		}
	)
	.post(
		'/wg/servers',
		async ({ body }) => {
			if (await isPortInUse(body.wgListenPort)) {
				return status(400, 'Port already in use by another server');
			}

			const privateKey = await wgGenKey();
			const publicKey = await wgDerivePublicKey(privateKey);

			if (!IPCIDR.isValidCIDR(body.cidrRange)) {
				return status(400, 'Invalid CIDR range');
			}

			if (!new IPCIDR(body.cidrRange).contains(body.wgAddress)) {
				return status(400, 'wgAddress is not in CIDR range');
			}

			const peer = await db
				.insert(serverPeersTable)
				.values({
					friendlyName: body.friendlyName,
					interfaceName: body.interfaceName,
					reservedIps: body.reservedIps,

					wgAddress: body.wgAddress,
					wgEndpoint: body.wgEndpoint,
					wgListenPort: body.wgListenPort,

					cidrRange: body.cidrRange,

					wgPrivateKey: privateKey,
					wgPublicKey: publicKey,

					enableNat: body.enableNat,

					// the column default is a literal 0 (epoch) - see schema.ts's statsSince comment
					statsSince: new Date(),
				})
				.returning();

			log.info(`Created server ${peer[0].id}`);
			startServer(peer[0]);
			syncFirewall();
			return peer;
		},
		{
			body: t.Object({
				friendlyName: t.String(),
				interfaceName: t.RegExp(/^[a-zA-Z0-9_=+.-]{1,15}$/),
				cidrRange: t.RegExp(/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[1-2][0-9]|3[0-2])$/),
				reservedIps: t.Integer({ default: 50 }),

				wgEndpoint: t.String(),
				wgListenPort: t.Integer(),
				wgAddress: t.String(),
				enableNat: t.Optional(t.Boolean({ default: false })),
			}),
			verifyAuth: { scope: 'admin' },
		}
	)
	.get(
		'/wg/servers/:id',
		async ({ params }) => {
			const server = await db.query.serverPeersTable.findFirst({
				where: or(eq(serverPeersTable.id, params.id), eq(serverPeersTable.interfaceName, params.id)),
			});

			if (!server) {
				return status(404, 'Server not found');
			}

			return server;
		},
		{
			params: t.Object({ id: t.String() }),
			verifyAuth: { scope: 'server' },
		}
	)
	.patch(
		'/wg/servers/:id',
		async ({ params, body }) => {
			const server = await db.query.serverPeersTable.findFirst({
				where: eq(serverPeersTable.id, params.id),
			});

			if (!server) {
				return status(404, 'Server not found');
			}

			if (body.wgListenPort && (await isPortInUse(body.wgListenPort, params.id))) {
				return status(400, 'Port already in use by another server');
			}

			if (body.cidrRange && !IPCIDR.isValidCIDR(body.cidrRange)) {
				return status(400, 'Invalid CIDR range');
			}

			if (body.wgAddress && !new IPCIDR(body.cidrRange ?? server.cidrRange).contains(body.wgAddress)) {
				return status(400, 'wgAddress is not in CIDR range');
			}

			const updatedServer = await db.update(serverPeersTable).set(body).where(eq(serverPeersTable.id, params.id)).returning();

			log.info(`Updated server ${updatedServer[0].id}`);
			reloadServer(updatedServer[0]);
			syncFirewall();

			return updatedServer;
		},
		{
			body: t.Object({
				friendlyName: t.Optional(t.String()),
				interfaceName: t.Optional(t.RegExp(/^[a-zA-Z0-9_=+.-]{1,15}$/)),
				cidrRange: t.Optional(t.RegExp(/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[1-2][0-9]|3[0-2])$/)),
				reservedIps: t.Optional(t.Integer()),
				wgEndpoint: t.Optional(t.String()),
				wgListenPort: t.Optional(t.Integer()),
				wgAddress: t.Optional(t.String()),
				enableNat: t.Optional(t.Boolean()),
			}),
			params: t.Object({
				id: t.String(),
			}),
			verifyAuth: { scope: 'server' },
		}
	)
	.get(
		'/wg/servers/:id/config',
		async ({ params }) => {
			const server = await db.query.serverPeersTable.findFirst({
				where: or(eq(serverPeersTable.id, params.id), eq(serverPeersTable.interfaceName, params.id)),
			});

			if (!server) {
				throw new Error('Server not found');
			}

			return await generateServerConfig(server);
		},
		{
			params: t.Object({
				id: t.String(),
			}),
			verifyAuth: { scope: 'server' },
		}
	);
