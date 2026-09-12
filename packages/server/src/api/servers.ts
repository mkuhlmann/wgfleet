import { Elysia, status, t } from 'elysia';
import { db } from '../db';
import { serverPeersTable } from '../db/schema';
import IPCIDR from 'ip-cidr';
import { eq, and, ne } from 'drizzle-orm';
import { wgDerivePublicKey, wgGenKey } from '../wg/shell';
import { converge } from '../wg/converge';
import { auth } from './auth';
import { createLog } from '@server/lib/log';
import { generateServerConfig } from '@server/wg/config';
import { CIDR_REGEX, INTERFACE_NAME_REGEX, WG_LISTEN_PORT_MAX, WG_LISTEN_PORT_MIN } from '@server/lib/validation';

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
		},
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

					dns: body.dns,

					// the column default is a literal 0 - see schema.ts's statsSince comment
					statsSince: new Date(),
				})
				.returning();

			log.info(`Created server ${peer[0].id}`);
			const convergeResult = await converge(peer[0].id);
			if (!convergeResult.ok) {
				log.warn(`Server ${peer[0].id} created but failed to converge: ${convergeResult.reason}`);
			}
			return peer;
		},
		{
			body: t.Object({
				friendlyName: t.String(),
				interfaceName: t.RegExp(INTERFACE_NAME_REGEX),
				cidrRange: t.RegExp(CIDR_REGEX),
				reservedIps: t.Integer({ default: 50 }),

				wgEndpoint: t.String(),
				wgListenPort: t.Integer({ minimum: WG_LISTEN_PORT_MIN, maximum: WG_LISTEN_PORT_MAX }),
				wgAddress: t.String(),
				dns: t.Optional(t.String()),
			}),
			verifyAuth: { scope: 'admin' },
		},
	)
	.get(
		'/wg/servers/:id',
		// `wgServer` is resolved and authorized by the serverScope macro (api/auth.ts)
		async ({ wgServer }) => wgServer,
		{
			params: t.Object({ id: t.String() }),
			serverScope: true,
		},
	)
	.patch(
		'/wg/servers/:id',
		async ({ wgServer: server, body }) => {
			if (body.wgListenPort && (await isPortInUse(body.wgListenPort, server.id))) {
				return status(400, 'Port already in use by another server');
			}

			if (body.cidrRange && !IPCIDR.isValidCIDR(body.cidrRange)) {
				return status(400, 'Invalid CIDR range');
			}

			if (body.wgAddress && !new IPCIDR(body.cidrRange ?? server.cidrRange).contains(body.wgAddress)) {
				return status(400, 'wgAddress is not in CIDR range');
			}

			const updatedServer = await db.update(serverPeersTable).set(body).where(eq(serverPeersTable.id, server.id)).returning();

			log.info(`Updated server ${updatedServer[0].id}`);
			// converge re-resolves the row itself, so it always reloads/starts using the
			// post-update config, whatever changed (including interfaceName).
			const convergeResult = await converge(server.id);
			if (!convergeResult.ok) {
				log.warn(`Server ${server.id} updated but failed to converge: ${convergeResult.reason}`);
			}

			return updatedServer;
		},
		{
			body: t.Object({
				friendlyName: t.Optional(t.String()),
				interfaceName: t.Optional(t.RegExp(INTERFACE_NAME_REGEX)),
				cidrRange: t.Optional(t.RegExp(CIDR_REGEX)),
				reservedIps: t.Optional(t.Integer()),
				wgEndpoint: t.Optional(t.String()),
				wgListenPort: t.Optional(t.Integer({ minimum: WG_LISTEN_PORT_MIN, maximum: WG_LISTEN_PORT_MAX })),
				wgAddress: t.Optional(t.String()),
				// null clears it - omitting the `DNS =` line from generated peer configs
				dns: t.Optional(t.Nullable(t.String())),
			}),
			params: t.Object({
				id: t.String(),
			}),
			serverScope: true,
		},
	)
	.get('/wg/servers/:id/config', async ({ wgServer }) => await generateServerConfig(wgServer), {
		params: t.Object({
			id: t.String(),
		}),
		serverScope: true,
	});
