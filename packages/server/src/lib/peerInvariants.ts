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
 * Returns the `Failure` (lib/failure.ts) naming the offending field, or null when the write
 * is allowed - so the form can put the message on the input that caused it rather than on
 * whichever one it guessed.
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

import { failure, type Failure } from './failure';
import { CIDR_REGEX } from './validation';

/** The subset of a peer write these rules care about. `undefined` means "leave unchanged". */
export type PeerInvariantRequest = {
	tagIds?: string[];
	isExitNode?: boolean;
	exitPeerId?: string | null;
};

const label = (peer: InvariantPeer) => peer.friendlyName ?? peer.wgAddress;

/**
 * The two rules about a single advertised prefix that depend on nothing but the prefix itself.
 * Separate from checkPeerInvariants because the overlap checks that go with them need every
 * other peer *on this host* (resolveAdvertisedRoutes, wg/addressing.ts) and stay server-side -
 * but these two do not, and the peer form used to restate them with a different message.
 */
export function checkAdvertisedRoute(entry: string): Failure | null {
	if (!CIDR_REGEX.test(entry)) {
		return failure(`Invalid or non-ipv4 CIDR: ${entry}`, 'advertisedRoutes');
	}

	// A /0 advertisement is an exit node wearing the wrong hat: it claims the same AllowedIPs
	// the exit node owns, so on an interface that has one the two would collide outright, and
	// on one that doesn't it would make the advertiser a de-facto exit node while bypassing
	// every invariant that role carries (one per interface, exitPeerId as the permission).
	// Point the operator at the feature that actually models this.
	if (entry.endsWith('/0')) {
		return failure('A default route (/0) is what an exit node advertises - mark the peer as an exit node instead of advertising 0.0.0.0/0 as a subnet route', 'advertisedRoutes');
	}

	return null;
}

export function checkPeerInvariants(snapshot: PeerInvariantSnapshot, current: InvariantPeer | null, request: PeerInvariantRequest): Failure | null {
	if (request.tagIds && request.tagIds.length > 0) {
		const known = new Set(snapshot.tagIds);
		// deduped, because the same tag named twice is one assignment - and asserting on the
		// raw length would reject a request the db is perfectly happy to accept
		if ([...new Set(request.tagIds)].some((id) => !known.has(id))) {
			return failure('One or more tags not found on this server', 'tagIds');
		}
	}

	const isExitNode = request.isExitNode ?? current?.isExitNode ?? false;
	const exitPeerId = request.exitPeerId === undefined ? (current?.exitPeerId ?? null) : request.exitPeerId;

	// An exit node routing its own internet traffic into itself is a loop, and its config
	// can't express both roles anyway (it needs cidrRange AllowedIPs, not 0.0.0.0/0).
	if (isExitNode && exitPeerId) {
		return failure('A peer cannot be an exit node and use an exit node at the same time', 'isExitNode');
	}

	if (current && request.isExitNode === false && current.isExitNode) {
		// Fail closed and loudly: silently unassigning the dependents would leave them with no
		// internet at all, with nothing in the UI explaining why.
		const dependents = snapshot.peers.filter((p) => p.exitPeerId === current.id);
		if (dependents.length) {
			return failure(`Still in use as an exit node by: ${dependents.map(label).join(', ')}. Reassign those peers first.`, 'isExitNode');
		}
	}

	if (request.exitPeerId) {
		if (current && request.exitPeerId === current.id) {
			return failure('A peer cannot use itself as its exit node', 'exitPeerId');
		}

		const target = snapshot.peers.find((p) => p.id === request.exitPeerId);

		if (!target) {
			return failure('Exit node not found on this server', 'exitPeerId');
		}

		// Any exit node on this server will do - each one owns 0.0.0.0/0 on an interface of its
		// own (wg/exitLinks.ts), so there is nothing for them to compete over and a client picks
		// freely. The rule this replaced ("a server has at most one exit node") was the direct
		// consequence of them all sharing the server's interface.

		if (!target.isExitNode) {
			return failure('That peer is not marked as an exit node', 'exitPeerId');
		}
	}

	return null;
}
