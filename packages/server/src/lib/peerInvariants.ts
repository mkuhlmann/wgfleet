/**
 * The rules a peer write has to satisfy that depend only on *this server's* peers, tags and
 * grants - which is all of the exit-node invariants and the tag-ownership check.
 *
 * Pure, and deliberately free of any db, http or CIDR-math import, because both sides of the
 * api need it: the route handler (api/serversPeers.ts, via wg/peerIntake.ts) and the peer form
 * (app/src/components/PeerModal.vue), which used to hand-mirror two of these and simply not
 * check the other four - those surfaced only as a toast after a round trip.
 *
 * None of these are db constraints - sqlite FK enforcement is never turned on in this codebase
 * - so this is the one place they hold. The reason they are rejected rather than silently
 * resolved is that wireguard and the kernel, not this codebase, are what break.
 *
 * Returns an error message, or null when the write is allowed.
 */

/** The peer columns these rules read. Structural, so the app's peer shape satisfies it too. */
export type InvariantPeer = {
	id: string;
	friendlyName: string | null;
	wgAddress: string;
	isExitNode: boolean;
	exitPeerId: string | null;
};

export type PeerInvariantSnapshot = {
	/** every peer on this server, including the one being edited */
	peers: InvariantPeer[];
	/** tag ids defined on this server */
	tagIds: string[];
};

/** The subset of a peer write these rules care about. `undefined` means "leave unchanged". */
export type PeerInvariantRequest = {
	tagIds?: string[];
	isExitNode?: boolean;
	exitPeerId?: string | null;
};

const label = (peer: InvariantPeer) => peer.friendlyName ?? peer.wgAddress;

export function checkPeerInvariants(snapshot: PeerInvariantSnapshot, current: InvariantPeer | null, request: PeerInvariantRequest): string | null {
	if (request.tagIds && request.tagIds.length > 0) {
		const known = new Set(snapshot.tagIds);
		// deduped, because the same tag named twice is one assignment - and asserting on the
		// raw length would reject a request the db is perfectly happy to accept
		if ([...new Set(request.tagIds)].some((id) => !known.has(id))) {
			return 'One or more tags not found on this server';
		}
	}

	const isExitNode = request.isExitNode ?? current?.isExitNode ?? false;
	const exitPeerId = request.exitPeerId === undefined ? (current?.exitPeerId ?? null) : request.exitPeerId;

	// An exit node routing its own internet traffic into itself is a loop, and its config
	// can't express both roles anyway (it needs cidrRange AllowedIPs, not 0.0.0.0/0).
	if (isExitNode && exitPeerId) {
		return 'A peer cannot be an exit node and use an exit node at the same time';
	}

	if (current && request.isExitNode === false && current.isExitNode) {
		// Fail closed and loudly: silently unassigning the dependents would leave them with no
		// internet at all, with nothing in the UI explaining why.
		const dependents = snapshot.peers.filter((p) => p.exitPeerId === current.id);
		if (dependents.length) {
			return `Still in use as an exit node by: ${dependents.map(label).join(', ')}. Reassign those peers first.`;
		}
	}

	if (request.exitPeerId) {
		if (current && request.exitPeerId === current.id) {
			return 'A peer cannot use itself as its exit node';
		}

		const target = snapshot.peers.find((p) => p.id === request.exitPeerId);

		if (!target) {
			return 'Exit node not found on this server';
		}

		// Any exit node on this server will do - each one owns 0.0.0.0/0 on an interface of its
		// own (wg/exitLinks.ts), so there is nothing for them to compete over and a client picks
		// freely. The rule this replaced ("a server has at most one exit node") was the direct
		// consequence of them all sharing the server's interface.

		if (!target.isExitNode) {
			return 'That peer is not marked as an exit node';
		}
	}

	return null;
}
