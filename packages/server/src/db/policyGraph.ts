import { db } from './index';
import { peerTagAssignmentsTable, peerTagsTable, peersTable, policyGrantsTable, type Peer, type PeerTag, type PeerTagAssignment, type PolicyGrant, type ServerPeer } from './schema';
import { asc, eq, inArray } from 'drizzle-orm';
import { resolveServer } from './servers';
import { advertisedRoutesOf, exitTopologyOf } from '@server/lib/exitTopology';

/**
 * One server's full policy graph: its tags, peers, peer<->tag assignments and grants
 * (every grant, enabled or not, ordered by position ascending). This is the one read of
 * that four-table shape - GET /tags, the JSON policy document, the peers-with-tagIds list,
 * the firewall ruleset and a peer's client-side AllowedIPs are all projections over the
 * same graph (see the functions below), instead of five independent traversals that have
 * to agree with each other by hand.
 */
export type PolicyGraph = {
	server: ServerPeer;
	tags: PeerTag[];
	peers: Peer[];
	// assignments for this server's peers only
	assignments: PeerTagAssignment[];
	// every grant on this server, ordered by position ascending - enabled and disabled alike;
	// projections that only care about active policy (e.g. wg/firewall.ts's toFirewallServer)
	// filter themselves
	grants: PolicyGrant[];
};

/**
 * The graph for a server row the caller already holds - which, since the serverScope macro
 * (api/auth.ts) resolves that row before the handler runs, is every route handler. Cannot
 * fail, so callers get a `PolicyGraph` rather than a maybe.
 */
export async function policyGraphOf(server: ServerPeer): Promise<PolicyGraph> {
	const [tags, peers, grants] = await Promise.all([
		db.query.peerTagsTable.findMany({ where: eq(peerTagsTable.serverPeerId, server.id) }),
		db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, server.id) }),
		db.query.policyGrantsTable.findMany({ where: eq(policyGrantsTable.serverPeerId, server.id), orderBy: asc(policyGrantsTable.position) }),
	]);

	const assignments = peers.length ? await db.query.peerTagAssignmentsTable.findMany({ where: inArray(peerTagAssignmentsTable.peerId, peers.map((p) => p.id)) }) : [];

	return { server, tags, peers, assignments, grants };
}

/** Resolve a server by id or interfaceName first - for callers that only hold a url parameter. */
export async function loadPolicyGraph(idOrInterfaceName: string): Promise<PolicyGraph | undefined> {
	const server = await resolveServer(idOrInterfaceName);
	if (!server) return undefined;

	return policyGraphOf(server);
}

// --- projections -----------------------------------------------------------------------
// Pure, in-process - no db, no io. Each answers one question that used to be its own
// traversal of the same four tables.

export function tagIdsByPeer(graph: PolicyGraph): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const a of graph.assignments) {
		const list = map.get(a.peerId) ?? [];
		list.push(a.tagId);
		map.set(a.peerId, list);
	}
	return map;
}

/**
 * Who the exit node is, who routes through it, and what LANs sit behind this interface's
 * peers. The derivation itself is pure and lives in lib/exitTopology.ts so the frontend can
 * share it; this is the projection over the graph the wg modules already hold.
 */
export const exitTopology = (graph: PolicyGraph) => exitTopologyOf(graph.peers);

export function memberCountByTag(graph: PolicyGraph): Map<string, number> {
	const map = new Map<string, number>();
	for (const a of graph.assignments) {
		map.set(a.tagId, (map.get(a.tagId) ?? 0) + 1);
	}
	return map;
}

export type PolicyDocument = {
	tags: { name: string; friendlyName?: string }[];
	grants: {
		enabled: boolean;
		action: 'allow' | 'deny';
		srcKind: 'tag' | 'peer';
		srcTag?: string;
		srcPeerId?: string;
		dstKind: 'tag' | 'peer' | 'cidr' | 'server' | 'internet' | 'any';
		dstTag?: string;
		dstPeerId?: string;
		dstCidr?: string;
		protocol: 'any' | 'tcp' | 'udp' | 'icmp';
		ports: string | null;
		comment: string | null;
	}[];
	peerTags: { peerId: string; friendlyName?: string; tags: string[] }[];
};

// The JSON policy document format (GET/PUT .../policy) - grants reference tags by name
// rather than id, since ids are meaningless to a human hand-editing the document and new
// tags in an imported document don't have ids yet.
export function toPolicyDocument(graph: PolicyGraph): PolicyDocument {
	const tagNameById = new Map(graph.tags.map((t) => [t.id, t.name]));

	const tagNamesByPeer = new Map<string, string[]>();
	for (const a of graph.assignments) {
		const name = tagNameById.get(a.tagId);
		if (!name) continue; // stale assignment - be defensive, ignore it
		const list = tagNamesByPeer.get(a.peerId) ?? [];
		list.push(name);
		tagNamesByPeer.set(a.peerId, list);
	}

	return {
		tags: graph.tags.map((tag) => ({ name: tag.name, friendlyName: tag.friendlyName ?? undefined })),
		grants: graph.grants.map((g) => ({
			enabled: g.enabled,
			action: g.action,
			srcKind: g.srcKind,
			srcTag: g.srcTagId ? tagNameById.get(g.srcTagId) : undefined,
			srcPeerId: g.srcPeerId ?? undefined,
			dstKind: g.dstKind,
			dstTag: g.dstTagId ? tagNameById.get(g.dstTagId) : undefined,
			dstPeerId: g.dstPeerId ?? undefined,
			dstCidr: g.dstCidr ?? undefined,
			protocol: g.protocol,
			ports: g.ports,
			comment: g.comment,
		})),
		peerTags: graph.peers
			.filter((p) => (tagNamesByPeer.get(p.id)?.length ?? 0) > 0)
			.map((p) => ({ peerId: p.id, friendlyName: p.friendlyName ?? undefined, tags: tagNamesByPeer.get(p.id)! })),
	};
}

/**
 * Client-side AllowedIPs is a routing hint, not the enforcement boundary - see wg/config.ts.
 * Only `allow` grants matter here, filtered to the ones applicable to this one peer (by its
 * own id or any of its tags).
 *
 * The `cidr`-dst grants appended here are also what makes an advertised subnet route
 * (`peers.advertisedRoutes`) show up in a permitted client's normal config: advertising adds
 * no new permission mechanism, so "which clients get the LAN in their AllowedIPs" is answered
 * by the same ordered grants list as every other destination.
 */
export function allowedIpsForPeer(graph: PolicyGraph, peer: Peer): string {
	const tagIds = new Set(graph.assignments.filter((a) => a.peerId === peer.id).map((a) => a.tagId));

	const applicable = graph.grants.filter(
		(g) => g.enabled && g.action === 'allow' && ((g.srcKind === 'peer' && g.srcPeerId === peer.id) || (g.srcKind === 'tag' && g.srcTagId !== null && tagIds.has(g.srcTagId)))
	);

	if (applicable.some((g) => g.dstKind === 'internet' || g.dstKind === 'any')) return '0.0.0.0/0';

	// A grant that hands a peer a LAN it advertises itself would route that LAN into the
	// tunnel on the machine that *is* its gateway - a loop, and the one case where a routing
	// hint can break the advertiser rather than merely be too narrow. Grants are written
	// against tags, so this is easy to hit by accident: tag the advertiser like its peers.
	const ownRoutes = new Set(advertisedRoutesOf(peer));
	const extraCidrs = applicable.filter((g) => g.dstKind === 'cidr' && g.dstCidr && !ownRoutes.has(g.dstCidr)).map((g) => g.dstCidr!);

	return [graph.server.cidrRange, ...extraCidrs].join(', ');
}
