import { type Peer, type ServerPeer } from '@server/db/schema';
import { allowedIpsForPeer, loadPolicyGraph, type PolicyGraph } from '@server/db/policyGraph';
import { advertisedRoutesOf, exitLinkOf, exitNodeFor, exitTopologyOf, type ExitNode } from '@server/lib/exitTopology';

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
 * The hub-side config for a server's own wg interface. Takes the policy graph rather than the
 * server row and a db read of its own: converge() already holds the fleet snapshot every other
 * artefact is rendered from, and re-reading the peers here made "which peer is on which
 * interface" a question with two answers that had to agree by hand.
 */
export const buildServerConfig = (graph: PolicyGraph): string => {
	const server = graph.server;
	const peers = graph.peers;

	// Same derivation the nft ruleset and the host's policy routing use - see
	// lib/exitTopology.ts. `plainPeers` is the load-bearing part: an exit node is *not* a peer
	// of this interface, it is the single peer of an exit link of its own
	// (generateExitLinkConfig below), which is what lets a server have more than one.
	const { plainPeers, interfaceAdvertisedRoutes } = exitTopologyOf(peers);
	const advertises = interfaceAdvertisedRoutes.length > 0;

	let config = `[Interface]
PrivateKey = ${server.wgPrivateKey}
Address = ${interfaceAddress(server)}
ListenPort = ${server.wgListenPort}
`;

	// wg-quick turns a peer's AllowedIPs into routes, and an advertiser owns a LAN prefix
	// outside cidrRange. wg-quick would route it correctly - but then two systems manage the
	// same routes, and the one that reconciles against the db (wg/exitRouting.ts) can no longer
	// tell a stale route of its own from wg-quick's. `Table = off` stops wg-quick touching the
	// routing table at all; the routes we actually need are the connected one from `Address`
	// above (which covers every peer, since peer AllowedIPs are otherwise inside cidrRange) and
	// the main-table subnet routes for advertisers, installed in wg/exitRouting.ts. Only
	// emitted for interfaces that actually advertise, so a deployment that touches neither
	// feature keeps generating byte-identical configs.
	if (advertises) {
		config += `Table = off\n`;
	}

	for (const peer of plainPeers) {
		config += peerSection(peer);
	}

	return config;
};

/**
 * One [Peer] block in a hub-side config. Server-side AllowedIPs *is* the enforcement boundary
 * (unlike the client's own copy): it is what makes the hub encrypt LAN-bound traffic to this
 * peer at all, and api-level overlap validation guarantees no two peers claim the same prefix.
 */
const peerSection = (peer: Peer, extraAllowedIps: string[] = []) => {
	const allowedIps = [...extraAllowedIps, peer.wgAddress, ...advertisedRoutesOf(peer)].join(', ');

	let section = `
[Peer]
PublicKey = ${peer.wgPublicKey}
AllowedIPs = ${allowedIps}
`;
	if (peer.wgPresharedKey) {
		section += `PreSharedKey = ${peer.wgPresharedKey}\n`;
	}
	return section;
};

/**
 * The hub-side config for one exit link - the interface a single exit node has to itself (see
 * wg/exitLinks.ts for why each one needs its own). Exactly one peer, which is what lets it own
 * `0.0.0.0/0` without taking that prefix away from any other exit node.
 *
 * Deliberately address-less. The exit node's own `/32` and the LANs it advertises are installed
 * as explicit routes on this device by wg/exitRouting.ts, so there is nothing for a connected
 * route to add - and an address here would have to be either a duplicate of the server's own
 * (which the kernel refuses on a second interface) or a made-up link subnet nobody asked for.
 * `Table = off` for the usual reason, and here it is not optional: this peer owns `0.0.0.0/0`,
 * which wg-quick would turn into a default route on the manager's own host.
 */
export const generateExitLinkConfig = (exitNode: ExitNode<Peer>): string => {
	const link = exitNode.link;
	if (!link) throw new Error(`Exit node ${exitNode.peer.id} has no provisioned exit link`);

	return (
		`[Interface]
PrivateKey = ${exitNode.peer.exitPrivateKey}
ListenPort = ${link.listenPort}
Table = off
` + peerSection(exitNode.peer, ['0.0.0.0/0'])
	);
};

export type PeerConfigOptions = {
	/**
	 * Render the "via its exit" variant: AllowedIPs becomes 0.0.0.0/0 so the client sends its
	 * internet traffic into the tunnel. Which exit that reaches is decided entirely server-side
	 * by the peer's selection - `exitPeerId` (a peer's uplink) or `exitViaServer` (its server's).
	 * Both are the permission as well as the routing, so a config generated for a peer that
	 * selected neither has no path to any uplink and simply blackholes.
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
//
// Resolved using pure bash regex matching rather than external tools like awk: wg-quick runs under
// an AppArmor profile on modern Linux (e.g. Ubuntu 24.04+) that whitelists ip and iptables but
// blocks /usr/bin/awk with "Permission denied".
const interfaceForRoute = (route: string) => `$(r=$(ip -4 route show ${route}); [[ $r =~ dev[[:space:]]+([^[:space:]]+) ]] && echo \${BASH_REMATCH[1]})`;

const UPLINK = interfaceForRoute('default');

// An exit link listens on the same host as its server, so its endpoint is the server's with a
// different port. Split on the *last* colon so a bare ipv6 literal host degrades to "no port
// found" rather than truncating the address - wgEndpoint is a free-form string.
const endpointHost = (endpoint: string) => {
	const at = endpoint.lastIndexOf(':');
	return at === -1 ? endpoint : endpoint.slice(0, at);
};

// The interface the advertised LAN is reachable on, scanned out of that machine's own route
// table. dev[[:space:]]+ captures the device name whether the route has a `via <gw>` or is a
// direct/connected route.
const lanInterface = (cidr: string) => interfaceForRoute(cidr);

// Enable forwarding, but tolerate a host where it is already on and simply not writable -
// a container or unprivileged LXC mounts /proc/sys read-only, so the bare `sysctl -w` fails
// there even when the orchestrator has already set the value from outside. wg-quick runs
// PostUp under `set -e` and *rolls the whole interface back* on a non-zero exit, so the bare
// form turns "cannot write an already-correct sysctl" into "the gateway's tunnel never comes
// up at all". Falling back to reading the value keeps the genuinely broken case (forwarding
// off and unsettable) loud, since the gateway cannot work at all in that state.
const ENABLE_FORWARDING = `sysctl -q -w net.ipv4.ip_forward=1 || test "$(cat /proc/sys/net/ipv4/ip_forward)" = 1`;

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
 * A peer that is both gets both rules, and either way one pair of filter/FORWARD accepts.
 */
const natLines = (options: { uplinkMasquerade: boolean; advertisedRoutes: string[]; vpnCidr: string }) => {
	const lines = [`PostUp = ${ENABLE_FORWARDING}`];

	// Unconditional, because masquerading is only half a gateway: the rules above live in
	// nat/POSTROUTING, which rewrites a packet but never decides whether it is forwarded at
	// all - filter/FORWARD does. A host whose FORWARD chain ends in a REJECT (the RHEL and
	// firewalld default) answers the client "Destination Host Prohibited"; one running docker,
	// which sets that chain's policy to DROP, answers nothing. Either way the gateway looks
	// configured, hands out handshakes, and forwards none of it. Distributions that leave the
	// chain empty and ACCEPT - Debian, Ubuntu - are the ones this is a no-op on, so emitting
	// it always costs nothing and is the fix precisely where the failure is hardest to read.
	//
	// `-I FORWARD 1` rather than `-A`: appended lands *after* that trailing reject and never
	// matches. Scoped to the vpn subnet rather than a blanket `-i %i -j ACCEPT`, since jumping
	// to the head of the chain would otherwise pre-empt the deliberate rules of a machine that
	// is also someone's router. The pair covers both roles symmetrically - exit node (vpn ->
	// uplink) and advertiser (vpn -> LAN) both forward out of the tunnel and need the replies
	// back in - so it is emitted once rather than per advertised route. PostDown deletes by
	// rule spec, not index, so unrelated rules shifting underneath it cannot remove the wrong
	// one. `%i` is expanded by wg-quick to the interface name.
	//
	// Necessary but not sufficient on a firewalld host: iptables-nft writes into the filter
	// table while firewalld keeps its own, both base chains run at the forward hook, and a
	// reject in either still wins. Those hosts need the interface put in a trusted zone - see
	// docs/exit-nodes-and-subnet-routes.md.
	const forward = [`-i %i -s ${options.vpnCidr} -j ACCEPT`, `-o %i -d ${options.vpnCidr} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`];

	for (const rule of forward) {
		lines.push(`PostUp = iptables -I FORWARD 1 ${rule}`, `PostDown = iptables -D FORWARD ${rule}`);
	}

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
	const topology = exitTopologyOf(graph.peers);
	const exitNode = exitNodeFor(topology, peer);

	// `::/0` alongside `0.0.0.0/0` deliberately blackholes v6 rather than tunnelling it: this
	// codebase is v4-only throughout (peers have no v6 address), so without it every v6 packet
	// would leave via the client's local uplink, bypassing the exit node entirely - the exact
	// leak an exit node exists to prevent. Not a toggle, because its only "off" setting leaks.
	const allowedIps = options.exit ? '0.0.0.0/0, ::/0' : allowedIpsForPeer(graph, peer);

	// An exit node's own resolver wins for the exit rendering - see peers.exitDns.
	const dns = (options.exit ? exitNode?.peer.exitDns : null) ?? server.dns;

	// An exit node does not connect to its server's interface at all - it is the single peer of
	// an exit link of its own, on its own udp port and behind its own hub keypair (see
	// wg/exitLinks.ts). Everything else about its config is identical, including its own
	// keypair and address, so an existing exit node only ever has to re-import these two lines.
	// A link-less exit node (not yet reconciled) falls back to the server's interface, where it
	// is not a peer - the config is inert rather than wrong, and the next converge fixes it.
	const link = exitLinkOf(peer);
	const hub = link && peer.exitPublicKey ? { publicKey: peer.exitPublicKey, endpoint: `${endpointHost(server.wgEndpoint)}:${link.listenPort}` } : { publicKey: server.wgPublicKey, endpoint: server.wgEndpoint };

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
PublicKey = ${hub.publicKey}
Endpoint = ${hub.endpoint}
AllowedIPs = ${allowedIps}
`;

	if (peer.wgPresharedKey) {
		config += `PreSharedKey = ${peer.wgPresharedKey}\n`;
	}

	config += `PersistentKeepalive = 25\n`;

	return config;
};
