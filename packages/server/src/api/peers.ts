import { Elysia, t } from 'elysia';
import { auth } from './auth';
import { generatePeerConfig } from '@server/wg/config';
import { PEER_CONFIG_QUERY } from './serversPeers';

export const peersRoutes = new Elysia().use(auth).get(
	'/wg/peers/:id/config',
	// `peer` is resolved and authorized by the peerScope macro (api/auth.ts). A peer-scoped
	// token can fetch its own exit variant, matching the existing contract that a peer may
	// always download its own config.
	async ({ peer, query }) => generatePeerConfig(peer, { exit: query.exit, nat: query.nat }),
	{
		params: t.Object({
			id: t.String(),
		}),
		query: PEER_CONFIG_QUERY,
		peerScope: true,
	}
);
