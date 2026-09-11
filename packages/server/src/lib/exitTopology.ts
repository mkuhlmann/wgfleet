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
	exitPeerId: string | null;
	advertisedRoutes: string | null;
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

export type ExitTopology<P> = {
	/**
	 * This wg interface's exit node, or undefined. At most one per interface, because only one
	 * peer can own `AllowedIPs = 0.0.0.0/0` on it - the api enforces that
	 * (assertExitNodeInvariants in api/serversPeers.ts). The id tie-break below only decides
	 * which one wins if a direct db write ever broke that invariant, so that a config, a
	 * ruleset and a routing table can't each pick a *different* exit node from the same rows.
	 */
	exitPeer: P | undefined;
	/** the exit node's ip, or null - what the wg modules interpolate */
	exitPeerIp: string | null;
	/** ips of the peers whose `exitPeerId` names that exit node, excluding the node itself */
	clientIps: string[];
	/** every subnet route advertised by any peer on this interface, already network-aligned */
	advertisedRoutes: string[];
};

/**
 * Who the exit node is, who routes through it, and what LANs sit behind this interface's peers
 * - one derivation, shared by the server config (wg/config.ts), the nft ruleset
 * (wg/firewall.ts), the host's policy routing (wg/exitRouting.ts) and the frontend's server
 * view. Pure. Each of those used to re-derive all four fields from the raw peer rows with its
 * own copy of the tie-break rule above.
 */
export function exitTopologyOf<P extends ExitTopologyPeer>(peers: P[]): ExitTopology<P> {
	const exitPeer: P | undefined = peers.filter((p) => p.isExitNode).sort((a, b) => a.id.localeCompare(b.id))[0];

	return {
		exitPeer,
		exitPeerIp: exitPeer?.wgAddress ?? null,
		clientIps: exitPeer ? peers.filter((p) => p.exitPeerId === exitPeer.id && p.id !== exitPeer.id).map((p) => p.wgAddress) : [],
		advertisedRoutes: peers.flatMap(advertisedRoutesOf),
	};
}
