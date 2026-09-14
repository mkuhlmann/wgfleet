import { Elysia, t } from 'elysia';
import { fail } from './failure';
import { db } from '../db';
import { serverPeersTable } from '../db/schema';
import { eq } from 'drizzle-orm';
import { wgDerivePublicKey, wgGenKey } from '../wg/shell';
import { converge } from '../wg/converge';
import { auth } from './auth';
import { createLog } from '@server/lib/log';
import { buildServerConfig } from '@server/wg/config';
import { policyGraphOf } from '@server/db/policyGraph';
import { CIDR_REGEX, INTERFACE_NAME_REGEX, WG_LISTEN_PORT_MAX, WG_LISTEN_PORT_MIN } from '@server/lib/validation';
import { checkServerInvariants } from '@server/lib/serverInvariants';

const log = createLog('http');

/** Every server on this host, as lib/serverInvariants.ts wants it. */
async function loadServerInvariantSnapshot() {
	const servers = await db.select({ id: serverPeersTable.id, interfaceName: serverPeersTable.interfaceName, wgListenPort: serverPeersTable.wgListenPort }).from(serverPeersTable);
	return { servers };
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
			// The same function ServerModal.vue validates with (lib/serverInvariants.ts), so the
			// two cross-row rules - a port another server already listens on, an address outside
			// the range - are checkable client-side instead of only by submitting.
			const invalid = checkServerInvariants(await loadServerInvariantSnapshot(), null, body);
			if (invalid) return fail(400, invalid);

			const privateKey = await wgGenKey();
			const publicKey = await wgDerivePublicKey(privateKey);

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
					isExitNode: body.isExitNode,

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
				// offer this server's own uplink as an exit - see serverPeers.isExitNode
				isExitNode: t.Optional(t.Boolean({ default: false })),
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
			const invalid = checkServerInvariants(await loadServerInvariantSnapshot(), server, body);
			if (invalid) return fail(400, invalid);

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
	.get('/wg/servers/:id/config', async ({ wgServer }) => buildServerConfig(await policyGraphOf(wgServer)), {
		params: t.Object({
			id: t.String(),
		}),
		serverScope: true,
	});
