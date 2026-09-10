import { Elysia, status, t } from 'elysia';
import { db } from '@server/db';
import { peersTable } from '../db/schema';
import { eq, and, or } from 'drizzle-orm';
import { auth } from './auth';
import { createLog } from '@server/lib/log';
import { generatePeerConfig } from '@server/wg/config';
import { PEER_CONFIG_QUERY } from './serversPeers';

const log = createLog('http');

export const peersRoutes = new Elysia().use(auth).get(
	'/wg/peers/:id/config',
	async ({ params, query }) => {
		const peer = await db.query.peersTable.findFirst({
			where: and(eq(peersTable.id, params.id)),
		});

		if (!peer) {
			return status(404, 'Peer not found');
		}

		// A peer-scoped token can fetch its own exit variant, matching the existing contract
		// that a peer may always download its own config.
		return generatePeerConfig(peer, { exit: query.exit, nat: query.nat });
	},
	{
		params: t.Object({
			id: t.String(),
		}),
		query: PEER_CONFIG_QUERY,
		verifyAuth: { scope: 'peer' },
	}
);
