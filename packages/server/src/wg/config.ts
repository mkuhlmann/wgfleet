import { db } from '@server/db';
import { peersTable, type Peer, type ServerPeer } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { allowedIpsForPeer, loadPolicyGraph } from '@server/db/policyGraph';

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

export const generatePeerConfig = async (peer: Peer) => {
	// Also gives us the peer's tags and this server's grants in one read - see
	// db/policyGraph.ts's allowedIpsForPeer for why AllowedIPs (a routing hint, not the
	// enforcement boundary - wg/firewall.ts's nft ruleset is that) still has to reflect them.
	const graph = await loadPolicyGraph(peer.serverPeerId);

	if (!graph) {
		throw new Error('Server not found.');
	}

	const server = graph.server;
	const allowedIps = allowedIpsForPeer(graph, peer);

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
