import { parseCidrList } from './validation';

/**
 * The peer columns this projection reads. Structural rather than `Peer` so the app can call it
 * with the peer shape the api actually returns (which omits the wgLast* bookkeeping columns -
 * see api/serversPeers.ts's GET /peers), and so this module stays free of any db import and
 * can be bundled into the frontend.
 */
export type ExitTopologyPeer = {
	id: string;
	wgAddress: string;
	isExitNode: boolean;
	exitViaServer: boolean;
	exitPeerId: string | null;
	advertisedRoutes: string | null;
	exitInterfaceName: string | null;
	exitListenPort: number | null;
	exitRouteTableId: number | null;
};

/**
 * The subnet routes a peer advertises, decoded from its comma-separated column. The one place
 * that knows `peers.advertisedRoutes` is a list rather than a single value - config rendering,
 * hub routing, the firewall and the api all go through here instead of splitting the string
 * themselves. Entries are already validated and network-aligned on write
 * (resolveAdvertisedRoutes in wg/addressing.ts), so callers can interpolate them straight into
 * a command. Re-exported from wg/addressing.ts, which is where most of its callers expect it.
 */
export const advertisedRoutesOf = (peer: { advertisedRoutes: string | null }): string[] => parseCidrList(peer.advertisedRoutes);

/**
 * An exit node's dedicated interface on the hub. Null while the columns are unprovisioned,
 * which is the state a row is in between "isExitNode became true" and the converge that
 * allocates it (wg/exitLinks.ts) - and the state every exit node created before those columns
 * existed starts in. Every consumer must therefore treat a link-less exit node as inert rather
 * than assume the columns are there.
 */
export type ExitLink = {
	interfaceName: string;
	listenPort: number;
	routeTableId: number;
};

export const exitLinkOf = (peer: ExitTopologyPeer): ExitLink | null =>
	peer.isExitNode && peer.exitInterfaceName && peer.exitListenPort !== null && peer.exitRouteTableId !== null ? { interfaceName: peer.exitInterfaceName, listenPort: peer.exitListenPort, routeTableId: peer.exitRouteTableId } : null;

export type ExitNode<P> = {
	peer: P;
	/** the exit node's own tunnel address - what the wg modules interpolate */
	ip: string;
	/** the peers whose `exitPeerId` names it, never including itself */
	clients: P[];
	/** the same, as ips */
	clientIps: string[];
	/** its interface on the hub, or null when not provisioned yet */
	link: ExitLink | null;
	/** subnet routes it advertises - these live on its link, not on the server's own interface */
	advertisedRoutes: string[];
};

export type ExitTopology<P> = {
	/**
	 * Every peer carrying `isExitNode`, ordered by id. Any number of them per server: each one
	 * owns `AllowedIPs = 0.0.0.0/0` on an interface of its own, so they never compete for the
	 * prefix (which wireguard resolves by silently reassigning it to the last writer).
	 *
	 * The order is not cosmetic - wg/firewall.ts derives ordinal nft object names from it.
	 */
	exitNodes: ExitNode<P>[];
	/** the peers that stay on the server's own wg interface - everything that is not an exit node */
	plainPeers: P[];
	/**
	 * ips of the peers that exit through the *server's* own uplink (`peers.exitViaServer`).
	 * Unlike an exit node's clients these need no routing at all - the host's own default route
	 * already goes where they want - so they appear only in the firewall, which is what
	 * masquerades them and what stops everyone else doing the same.
	 */
	serverExitClientIps: string[];
	/** subnet routes advertised by peers on the server's own interface */
	interfaceAdvertisedRoutes: string[];
	/** every subnet route on this server, wherever its advertiser lives */
	allAdvertisedRoutes: string[];
};

/**
 * Which peers are exit nodes, who routes through each of them, and what LANs sit behind this
 * server's peers - one derivation, shared by the server and exit-link configs (wg/config.ts),
 * the nft ruleset (wg/firewall.ts), the host's policy routing (wg/exitRouting.ts) and the
 * frontend's server and policy views. Pure.
 *
 * The split between `exitNodes` and `plainPeers` is the load-bearing part: an exit node is
 * *not* a peer of its server's wg interface, it is the single peer of its own. Every consumer
 * that iterates "this server's peers" has to pick one of the two lists deliberately, which is
 * what stops an exit node quietly reappearing on the shared interface and taking `0.0.0.0/0`
 * back from another one.
 */
export function exitTopologyOf<P extends ExitTopologyPeer>(peers: P[]): ExitTopology<P> {
	const exitPeers = peers.filter((p) => p.isExitNode).sort((a, b) => a.id.localeCompare(b.id));
	const plainPeers = peers.filter((p) => !p.isExitNode);

	const exitNodes: ExitNode<P>[] = exitPeers.map((peer) => {
		const clients = peers.filter((p) => p.exitPeerId === peer.id && p.id !== peer.id);

		return {
			peer,
			ip: peer.wgAddress,
			clients,
			clientIps: clients.map((p) => p.wgAddress),
			link: exitLinkOf(peer),
			advertisedRoutes: advertisedRoutesOf(peer),
		};
	});

	return {
		exitNodes,
		plainPeers,
		serverExitClientIps: peers.filter((p) => p.exitViaServer).map((p) => p.wgAddress),
		interfaceAdvertisedRoutes: plainPeers.flatMap(advertisedRoutesOf),
		allAdvertisedRoutes: peers.flatMap(advertisedRoutesOf),
	};
}

/** The exit node a peer is assigned to, or undefined - resolved against the same projection. */
export const exitNodeFor = <P extends ExitTopologyPeer>(topology: ExitTopology<P>, peer: { exitPeerId: string | null }): ExitNode<P> | undefined => (peer.exitPeerId ? topology.exitNodes.find((node) => node.peer.id === peer.exitPeerId) : undefined);
