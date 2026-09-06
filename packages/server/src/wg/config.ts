import { db } from '@server/db';
import { peerTagAssignmentsTable, peersTable, policyGrantsTable, serverPeersTable, type Peer, type ServerPeer } from '@server/db/schema';
import { and, eq } from 'drizzle-orm';

export const generateServerConfig = async (server: ServerPeer) => {
	const peers = await db.query.peersTable.findMany({
		where: eq(peersTable.serverPeerId, server.id),
	});

	let config = `[Interface]
PrivateKey = ${server.wgPrivateKey}
Address = ${server.wgAddress.includes('/') ? server.wgAddress : server.wgAddress + '/24'}
ListenPort = ${server.wgListenPort}
`;

	for (const peer of peers) {
		config += `
[Peer]
PublicKey = ${peer.wgPublicKey}
AllowedIPs = ${peer.wgAddress}
`;
		if (peer.wgPresharedKey) {
			config += `PreSharedKey = ${peer.wgPresharedKey}\n`;
		}
	}

	return config;
};

/**
 * Client-side AllowedIPs is a routing hint, not the enforcement boundary - the
 * server's nft ruleset (see wg/firewall.ts) is what actually decides reachability.
 * A client can't reach an allowed subnet or the internet unless its own config
 * routes that traffic into the tunnel in the first place, so this still has to
 * reflect the peer's applicable grants. Only `allow` grants matter here (a `deny`
 * needs no route, and ordering/precedence between them doesn't either - the worst
 * a stale route can do is send traffic the firewall then drops). Peers reachable
 * via a dstKind 'tag'/'peer'/'server' grant need no extra entry here - they're
 * other peers (or the gateway) on the same server.cidrRange, already covered by
 * the base entry.
 */
const computeClientAllowedIps = async (peer: Peer, server: ServerPeer) => {
	const assignments = await db.query.peerTagAssignmentsTable.findMany({ where: eq(peerTagAssignmentsTable.peerId, peer.id) });
	const tagIds = new Set(assignments.map((a) => a.tagId));

	const grants = await db.query.policyGrantsTable.findMany({
		where: and(eq(policyGrantsTable.serverPeerId, server.id), eq(policyGrantsTable.enabled, true), eq(policyGrantsTable.action, 'allow')),
	});

	const applicable = grants.filter((g) => (g.srcKind === 'peer' && g.srcPeerId === peer.id) || (g.srcKind === 'tag' && g.srcTagId !== null && tagIds.has(g.srcTagId)));

	if (applicable.some((g) => g.dstKind === 'internet' || g.dstKind === 'any')) return '0.0.0.0/0';

	const extraCidrs = applicable.filter((g) => g.dstKind === 'cidr' && g.dstCidr).map((g) => g.dstCidr!);

	return [server.cidrRange, ...extraCidrs].join(', ');
};

export const generatePeerConfig = async (peer: Peer) => {
	const server = await db.query.serverPeersTable.findFirst({
		where: eq(serverPeersTable.id, peer.serverPeerId),
	});

	if (!server) {
		throw new Error('Server not found.');
	}

	const allowedIps = await computeClientAllowedIps(peer, server);

	let config = `[Interface]
PrivateKey = ${peer.wgPrivateKey}
Address = ${peer.wgAddress.includes('/') ? peer.wgAddress : peer.wgAddress + '/32'}

[Peer]
PublicKey = ${server.wgPublicKey}
Endpoint = ${server.wgEndpoint}
AllowedIPs = ${allowedIps}
`;

	if (peer.wgPresharedKey) {
		config += `PreSharedKey = ${peer.wgPresharedKey}\n`;
	}

	config += `PersistentKeepalive = 25\n`;

	return config;
};
