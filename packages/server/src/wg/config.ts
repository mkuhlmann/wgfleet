import { db } from '@server/db';
import { peersTable, type Peer, type ServerPeer } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { allowedIpsForPeer, loadPolicyGraph } from '@server/db/policyGraph';
import { advertisedRoutesOf } from './addressing';

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
	const advertises = peers.some((p) => advertisedRoutesOf(p).length > 0);

	let config = `[Interface]
PrivateKey = ${server.wgPrivateKey}
Address = ${interfaceAddress(server)}
ListenPort = ${server.wgListenPort}
`;

	// wg-quick turns a peer's AllowedIPs into routes, and both features below put a prefix
	// outside cidrRange in there:
	//   - the exit peer owns 0.0.0.0/0, which for wg-quick means a default route (plus its
	//     fwmark kill-switch rule) on the host running this manager, hijacking the manager's
	//     own internet;
	//   - an advertiser owns a LAN prefix, which wg-quick would route correctly - but then two
	//     systems manage the same routes, and the one that reconciles against the db
	//     (wg/exitRouting.ts) can no longer tell a stale route of its own from wg-quick's.
	// `Table = off` stops wg-quick touching the routing table at all; the routes we actually
	// need are the connected one from `Address` above (which covers every peer, since peer
	// AllowedIPs are otherwise inside cidrRange), the per-client policy routes for exit
	// clients, and the main-table subnet routes for advertisers - all in wg/exitRouting.ts.
	// Only emitted for interfaces that use one of the two features, so a deployment that
	// touches neither keeps generating byte-identical configs.
	if (exitPeer || advertises) {
		config += `Table = off\n`;
	}

	for (const peer of peers) {
		// The exit node owns everything not claimed by a more specific AllowedIPs. wg matches
		// longest-prefix, so every other peer's /32 still wins and the exit node stays an
		// entirely ordinary peer - reachable, and reaching others, exactly as before.
		const base = peer.id === exitPeer?.id ? `0.0.0.0/0, ${peer.wgAddress}/32` : peer.wgAddress;

		// Server-side AllowedIPs *is* the enforcement boundary here (unlike the client's own
		// copy): it is what makes the hub encrypt LAN-bound traffic to this peer at all, and
		// api-level overlap validation guarantees no two peers on this interface claim the same
		// prefix. Composes with the exit case - an advertiser that is also the exit node lists
		// the LAN explicitly even though its /0 already covers it, so `wg show` names the owner.
		const allowedIps = [base, ...advertisedRoutesOf(peer)].join(', ');

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
	 * Only meaningful for an exit node's or an advertiser's *own* config: append the
	 * PostUp/PostDown lines that turn its machine into a gateway. Opt-in because it requires
	 * wg-quick as root there.
	 */
	nat?: boolean;
};

// Resolved on the gateway machine at bring-up rather than guessed here - the manager has no way
// to know that machine's interface names, and a wrong guess produces an exit node/advertiser
// that looks configured and silently NATs nothing.
const UPLINK = `$(ip -4 route show default | awk '{print $5; exit}')`;

// The interface the advertised LAN is reachable on, scanned out of that machine's own route
// table. Not $5 like UPLINK above: a connected route prints `<cidr> dev <iface> proto kernel
// scope link src <ip>`, so `dev` is at a different offset than in a default route.
const lanInterface = (cidr: string) => `$(ip -4 route show ${cidr} | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit }}')`;

/**
 * The gateway PostUp/PostDown block for a peer that forwards for others. Two different
 * masquerade rules, because the two features masquerade in opposite directions:
 *
 *   - an exit node NATs vpn traffic onto its own *uplink*, for any destination;
 *   - an advertiser NATs vpn traffic onto its *LAN*, and only traffic from the vpn subnet -
 *     a blanket masquerade would also rewrite the machine's own LAN traffic, and NATing
 *     everything onto the LAN interface is not what "the LAN can't route back to the vpn"
 *     needs. This one is strictly optional: it is only required when the LAN has no route
 *     back to the vpn subnet, which is the common case for a LAN whose router this isn't.
 *
 * A peer that is both gets both rules.
 */
const natLines = (options: { uplinkMasquerade: boolean; advertisedRoutes: string[]; vpnCidr: string }) => {
	const lines = [`PostUp = sysctl -q -w net.ipv4.ip_forward=1`];

	if (options.uplinkMasquerade) {
		lines.push(`PostUp = iptables -t nat -A POSTROUTING -o ${UPLINK} -j MASQUERADE`, `PostDown = iptables -t nat -D POSTROUTING -o ${UPLINK} -j MASQUERADE`);
	}

	for (const cidr of options.advertisedRoutes) {
		lines.push(`PostUp = iptables -t nat -A POSTROUTING -s ${options.vpnCidr} -o ${lanInterface(cidr)} -j MASQUERADE`, `PostDown = iptables -t nat -D POSTROUTING -s ${options.vpnCidr} -o ${lanInterface(cidr)} -j MASQUERADE`);
	}

	return lines.join('\n') + '\n';
};

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
		const routes = advertisedRoutesOf(peer);
		config += natLines({
			// An advertiser NATs onto its LAN, scoped to the vpn subnet. Every other peer - an
			// exit node, or a plain peer whose operator asked for the block by hand - keeps the
			// blanket uplink masquerade ?nat= has always emitted, byte for byte.
			uplinkMasquerade: peer.isExitNode || routes.length === 0,
			advertisedRoutes: routes,
			vpnCidr: server.cidrRange,
		});
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
