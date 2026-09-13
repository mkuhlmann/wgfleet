import type { Peer, PeerTag, PeerTagAssignment, PolicyGrant, ServerPeer } from '@server/db/schema';
import type { PolicyGraph } from '@server/db/policyGraph';

/**
 * Builds a `PolicyGraph` - the shape `loadFleet()` hands the ruleset and the routing builders -
 * from a compact description, with no db.
 *
 * The modules under test (wg/firewall.ts, wg/exitRouting.ts, wg/config.ts, wg/plan.ts) take a
 * fleet snapshot, so their tests drive the same row shapes the db actually returns rather than
 * a hand-built projection. That projection - resolving tags to member ips, deciding which peers
 * are governed, dropping unresolvable grants - used to sit *above* their seam and was therefore
 * exercised by nothing.
 */

const EPOCH = new Date(0);

export type PeerSpec = {
	id: string;
	ip: string;
	/** tag ids this peer carries (peerTagAssignmentsTable) */
	tags?: string[];
	isExitNode?: boolean;
	/** the exit node this peer routes through */
	exitPeerId?: string;
	exitDns?: string | null;
	advertisedRoutes?: string | null;
	/** the provisioned exit link, when this peer is an exit node; omit for "not reconciled yet" */
	link?: { interfaceName: string; listenPort: number; routeTableId: number } | null;
	presharedKey?: string | null;
};

export type GrantSpec = {
	action?: 'allow' | 'deny';
	enabled?: boolean;
	protocol?: 'any' | 'tcp' | 'udp' | 'icmp';
	ports?: string | null;
	comment?: string | null;
} & ({ srcTag: string } | { srcPeer: string } | { srcKind: 'tag' | 'peer' }) &
	({ dstTag: string } | { dstPeer: string } | { dstCidr: string } | { dst: 'server' | 'any' } | { dstKind: PolicyGrant['dstKind'] });

export type GraphSpec = {
	id?: string;
	interfaceName?: string;
	cidrRange?: string;
	wgAddress?: string;
	dns?: string | null;
	wgEndpoint?: string;
	wgListenPort?: number;
	tags?: ({ id: string; name?: string; friendlyName?: string | null } | string)[];
	peers?: PeerSpec[];
	/** in evaluation order - index becomes `position` */
	grants?: GrantSpec[];
};

const serverRow = (spec: GraphSpec): ServerPeer => ({
	id: spec.id ?? 's0',
	createdAt: EPOCH,
	updatedAt: EPOCH,
	friendlyName: null,
	authToken: `${spec.id ?? 's0'}-token`,
	interfaceName: spec.interfaceName ?? 'wg0',
	cidrRange: spec.cidrRange ?? '10.20.20.0/24',
	reservedIps: 50,
	wgEndpoint: spec.wgEndpoint ?? 'vpn.example.com:51820',
	wgListenPort: spec.wgListenPort ?? 51820,
	wgAddress: spec.wgAddress ?? '10.20.20.1',
	wgPrivateKey: 'serverPrivateKey',
	wgPublicKey: 'serverPublicKey',
	dns: spec.dns ?? null,
	lifetimeRxBytes: 0,
	lifetimeTxBytes: 0,
	statsSince: EPOCH,
});

const peerRow = (serverPeerId: string, spec: PeerSpec): Peer => ({
	id: spec.id,
	createdAt: EPOCH,
	updatedAt: EPOCH,
	friendlyName: null,
	authToken: `${spec.id}-token`,
	serverPeerId,
	wgAddress: spec.ip,
	wgPrivateKey: `${spec.id}-privateKey`,
	wgPublicKey: `${spec.id}-publicKey`,
	wgPresharedKey: spec.presharedKey ?? null,
	isExitNode: spec.isExitNode ?? false,
	exitInterfaceName: spec.link?.interfaceName ?? null,
	exitPrivateKey: spec.link ? `${spec.id}-linkPrivateKey` : null,
	exitPublicKey: spec.link ? `${spec.id}-linkPublicKey` : null,
	exitListenPort: spec.link?.listenPort ?? null,
	exitRouteTableId: spec.link?.routeTableId ?? null,
	exitPeerId: spec.exitPeerId ?? null,
	exitDns: spec.exitDns ?? null,
	advertisedRoutes: spec.advertisedRoutes ?? null,
	wgLastRxBytes: 0,
	wgLastTxBytes: 0,
	wgLastSampledAt: null,
	lifetimeRxBytes: 0,
	lifetimeTxBytes: 0,
	statsSince: EPOCH,
});

const grantRow = (serverPeerId: string, spec: GrantSpec, position: number): PolicyGrant => {
	const s = spec as unknown as Record<string, string | undefined>;

	const srcKind = 'srcTag' in spec ? 'tag' : 'srcPeer' in spec ? 'peer' : ((s.srcKind ?? 'tag') as 'tag' | 'peer');
	const dstKind = 'dstTag' in spec ? 'tag' : 'dstPeer' in spec ? 'peer' : 'dstCidr' in spec ? 'cidr' : 'dst' in spec ? (s.dst as 'server' | 'any') : ((s.dstKind ?? 'any') as PolicyGrant['dstKind']);

	return {
		id: `${serverPeerId}-g${position}`,
		createdAt: EPOCH,
		updatedAt: EPOCH,
		serverPeerId,
		position,
		enabled: spec.enabled ?? true,
		action: spec.action ?? 'allow',
		srcKind,
		srcTagId: s.srcTag ?? null,
		srcPeerId: s.srcPeer ?? null,
		dstKind,
		dstTagId: s.dstTag ?? null,
		dstPeerId: s.dstPeer ?? null,
		dstCidr: s.dstCidr ?? null,
		protocol: spec.protocol ?? 'any',
		ports: spec.ports ?? null,
		comment: spec.comment ?? null,
	};
};

export const graphOf = (spec: GraphSpec = {}): PolicyGraph => {
	const server = serverRow(spec);

	const tags: PeerTag[] = (spec.tags ?? []).map((t) => {
		const tag = typeof t === 'string' ? { id: t } : t;
		return {
			id: tag.id,
			createdAt: EPOCH,
			updatedAt: EPOCH,
			serverPeerId: server.id,
			name: 'name' in tag && tag.name ? tag.name : tag.id,
			friendlyName: 'friendlyName' in tag ? (tag.friendlyName ?? null) : null,
		};
	});

	const peers = (spec.peers ?? []).map((p) => peerRow(server.id, p));

	const assignments: PeerTagAssignment[] = (spec.peers ?? []).flatMap((p) =>
		(p.tags ?? []).map((tagId) => ({
			id: `${p.id}-${tagId}`,
			createdAt: EPOCH,
			peerId: p.id,
			tagId,
		})),
	);

	return { server, tags, peers, assignments, grants: (spec.grants ?? []).map((g, i) => grantRow(server.id, g, i)) };
};
