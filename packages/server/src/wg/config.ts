import { db } from '@server/db';
import { peersTable, type Peer, type ServerPeer } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { allowedIpsForPeer, loadPolicyGraph } from '@server/db/policyGraph';

/**
 * The interface `Address` line's prefix. Historically this hardcoded /24 whenever wgAddress
 * carried no prefix, which was harmless while wg-quick installed a route per peer AllowedIPs.
 * It is not harmless once an interface uses `Table = off` (see exitPeerFor below): the
 * connected route derived from this prefix becomes the *only* thing that makes the server's
 * peers routable, so a /24 on a server whose cidrRange is a /16 would silently blackhole
 * every peer outside the first 256 addresses.
 */
const interfaceAddress = (server: ServerPeer): string => {
	if (server.wgAddress.includes('/')) return server.wgAddress;

	// cidrRange is validated by CIDR_REGEX (api/servers.ts) so it always carries a prefix;
	// the /24 fallback only covers a row written directly to the db.
	const prefix = server.cidrRange.split('/')[1];
	return `${server.wgAddress}/${prefix || '24'}`;
};

/**
 * The server's exit node, if it has one: the single peer whose traffic every exit client is
 * policy-routed into (see wg/exitRouting.ts). At most one per interface, because only one
 * peer can own `AllowedIPs = 0.0.0.0/0` on a wg interface - the api enforces that
 * (api/serversPeers.ts); this picks the first deterministically if a direct db write ever
 * broke the invariant, rather than emitting a config with two 0.0.0.0/0 peers.
 */
const exitPeerFor = (peers: Peer[]): Peer | undefined => peers.filter((p) => p.isExitNode).sort((a, b) => a.id.localeCompare(b.id))[0];

export const generateServerConfig = async (server: ServerPeer) => {
	const peers = await db.query.peersTable.findMany({
		where: eq(peersTable.serverPeerId, server.id),
	});

	const exitPeer = exitPeerFor(peers);

	let config = `[Interface]
PrivateKey = ${server.wgPrivateKey}
Address = ${interfaceAddress(server)}
ListenPort = ${server.wgListenPort}
`;

	// The exit peer below owns AllowedIPs 0.0.0.0/0, and wg-quick turns a peer's AllowedIPs
	// into routes - for /0 that means a default route (plus its fwmark kill-switch rule) on
	// the host running this manager, hijacking the manager's own internet. `Table = off`
	// stops wg-quick touching the routing table at all; the routes we actually need are the
	// connected one from `Address` above (which covers every peer, since generateServerConfig
	// only ever emits AllowedIPs inside cidrRange) plus the per-client policy routes in
	// wg/exitRouting.ts. Only emitted for interfaces that have an exit node, so a deployment
	// that never touches the feature keeps generating byte-identical configs.
	if (exitPeer) {
		config += `Table = off\n`;
	}

	for (const peer of peers) {
		// The exit node owns everything not claimed by a more specific AllowedIPs. wg matches
		// longest-prefix, so every other peer's /32 still wins and the exit node stays an
		// entirely ordinary peer - reachable, and reaching others, exactly as before.
		const allowedIps = peer.id === exitPeer?.id ? `0.0.0.0/0, ${peer.wgAddress}/32` : peer.wgAddress;

		config += `
[Peer]
PublicKey = ${peer.wgPublicKey}
AllowedIPs = ${allowedIps}
`;
		if (peer.wgPresharedKey) {
			config += `PreSharedKey = ${peer.wgPresharedKey}\n`;
		}
	}

	return config;
};

export type PeerConfigOptions = {
	/**
	 * Render the "via exit node" variant: AllowedIPs becomes 0.0.0.0/0 so the client sends
	 * its internet traffic into the tunnel. Requires the peer to have an exitPeerId - that
	 * column is the permission, and without it the hub installs no policy route, so a config
	 * generated here anyway would simply have no path to the exit node's uplink.
	 */
	exit?: boolean;
	/**
	 * Only meaningful for an exit node's *own* config: append the PostUp/PostDown lines that
	 * turn its machine into a gateway. Opt-in because it requires wg-quick as root there.
	 */
	nat?: boolean;
};

// Resolved on the exit node at bring-up rather than guessed here - the manager has no way to
// know that machine's uplink interface name, and a wrong guess produces an exit node that
// looks configured and silently NATs nothing.
const UPLINK = `$(ip -4 route show default | awk '{print $5; exit}')`;

const natLines = () => [`PostUp = sysctl -q -w net.ipv4.ip_forward=1`, `PostUp = iptables -t nat -A POSTROUTING -o ${UPLINK} -j MASQUERADE`, `PostDown = iptables -t nat -D POSTROUTING -o ${UPLINK} -j MASQUERADE`].join('\n') + '\n';

export const generatePeerConfig = async (peer: Peer, options: PeerConfigOptions = {}) => {
	// Also gives us the peer's tags and this server's grants in one read - see
	// db/policyGraph.ts's allowedIpsForPeer for why AllowedIPs (a routing hint, not the
	// enforcement boundary - wg/firewall.ts's nft ruleset is that) still has to reflect them.
	const graph = await loadPolicyGraph(peer.serverPeerId);

	if (!graph) {
		throw new Error('Server not found.');
	}

	const server = graph.server;
	const exitPeer = peer.exitPeerId ? graph.peers.find((p) => p.id === peer.exitPeerId) : undefined;

	// `::/0` alongside `0.0.0.0/0` deliberately blackholes v6 rather than tunnelling it: this
	// codebase is v4-only throughout (peers have no v6 address), so without it every v6 packet
	// would leave via the client's local uplink, bypassing the exit node entirely - the exact
	// leak an exit node exists to prevent. Not a toggle, because its only "off" setting leaks.
	const allowedIps = options.exit ? '0.0.0.0/0, ::/0' : allowedIpsForPeer(graph, peer);

	// An exit node's own resolver wins for the exit rendering - see peers.exitDns.
	const dns = (options.exit ? exitPeer?.exitDns : null) ?? server.dns;

	let config = `[Interface]
PrivateKey = ${peer.wgPrivateKey}
Address = ${peer.wgAddress.includes('/') ? peer.wgAddress : peer.wgAddress + '/32'}
`;

	if (dns) {
		config += `DNS = ${dns}\n`;
	}

	if (options.nat) {
		config += natLines();
	}

	config += `
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
