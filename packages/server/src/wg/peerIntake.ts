import { db } from '@server/db';
import { peersTable, peerTagsTable, type Peer, type ServerPeer } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { checkPeerInvariants } from '@server/lib/peerInvariants';
import { advertisedRoutesOf } from '@server/lib/exitTopology';
import { resolveAdvertisedRoutes, resolvePeerAddress } from './addressing';
import { loadExitLinkTaken } from './exitLinks';
import { WG_LISTEN_PORT_MAX, WG_LISTEN_PORT_MIN } from '@server/lib/validation';
import { failure, type Failure } from '@server/lib/failure';

/**
 * Everything a peer write can set. `undefined` means "leave unchanged" on update and "use the
 * default" on create; `null` on the nullable columns means "explicitly clear".
 */
export type PeerWriteRequest = {
	friendlyName?: string;
	wgAddress?: string;
	tagIds?: string[];
	isExitNode?: boolean;
	exitPeerId?: string | null;
	exitViaServer?: boolean;
	exitDns?: string | null;
	advertisedRoutes?: string | null;
	/** operator-pinned udp port for this exit node's link; null/undefined = allocate one */
	exitListenPort?: number | null;
};

/** The column values to write, already defaulted, validated and normalised. */
export type ResolvedPeerWrite = {
	friendlyName: string | undefined;
	wgAddress: string;
	isExitNode: boolean;
	exitPeerId: string | null;
	exitViaServer: boolean;
	exitDns: string | null;
	advertisedRoutes: string | null;
	exitListenPort: number | null;
	/** undefined = leave assignments alone, [] = clear them all (unrestrict) */
	tagIds: string[] | undefined;
};

export type PeerWriteResult = { ok: true; values: ResolvedPeerWrite } | { ok: false; failure: Failure };

/**
 * Resolves one peer write - create when `current` is null, update otherwise - into the column
 * values to store, or a single `Failure` naming the field that was refused.
 *
 * This is the whole peer write path behind one interface. It used to be four helpers called in
 * sequence by two near-identical handlers, each returning errors in a different shape (a
 * result union, a `Response | null`, and a result union wrapping a `Response`), with the
 * invariants themselves expressed as `status(400, ...)` - so they could only be exercised
 * through http, and the peer form re-implemented two of them by hand.
 *
 * The order of checks is load-bearing only in that it decides which message a request that
 * breaks several rules at once gets back; it matches what the handlers did before.
 */
export async function resolvePeerWrite(server: ServerPeer, current: Peer | null, request: PeerWriteRequest): Promise<PeerWriteResult> {
	// Address first, and only when the request actually asks to change it - a PATCH that just
	// renames a peer or edits its tags must not spuriously fail because the server's address
	// range happens to be exhausted.
	let wgAddress = current?.wgAddress ?? '';
	if (!current || request.wgAddress) {
		const peers = await db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, server.id), columns: { wgAddress: true } });
		const taken = new Set(peers.map((p) => p.wgAddress).filter((address) => address !== current?.wgAddress));

		// The interface's own address is as taken as any peer's. `reservedIps` usually hides
		// this - the default 50 puts the whole allocation window above a hub sitting on .1 - but
		// it's a convention, not a constraint: lower it, or give the server a high address in
		// its own range, and auto-allocation hands a peer the hub's ip. wireguard then has two
		// owners for one address and neither that peer nor anything relying on the hub's own
		// address works.
		taken.add(server.wgAddress);

		const resolved = resolvePeerAddress(server.cidrRange, server.reservedIps, taken, { requested: request.wgAddress });
		if (!resolved.ok) return resolved;

		wgAddress = resolved.ip;
	}

	const invariantError = checkPeerInvariants(await loadInvariantSnapshot(server), current, request);
	if (invariantError) return { ok: false, failure: invariantError };

	const advertised = await resolveAdvertisedRoutesFor(server, current, request);
	if (!advertised.ok) return advertised;

	const exitListenPort = await resolveExitListenPort(current, request);
	if (!exitListenPort.ok) return exitListenPort;

	return {
		ok: true,
		values: {
			friendlyName: request.friendlyName ?? current?.friendlyName ?? undefined,
			wgAddress,
			isExitNode: request.isExitNode ?? current?.isExitNode ?? false,
			exitPeerId: request.exitPeerId === undefined ? (current?.exitPeerId ?? null) : request.exitPeerId,
			exitViaServer: request.exitViaServer ?? current?.exitViaServer ?? false,
			exitDns: request.exitDns === undefined ? (current?.exitDns ?? null) : request.exitDns,
			advertisedRoutes: advertised.value,
			exitListenPort: exitListenPort.value,
			tagIds: request.tagIds,
		},
	};
}

/**
 * The udp port this peer's exit link should listen on. Validated here rather than left to
 * reconcileExitLinks so a bad port is a 400 on the request that asked for it, instead of a
 * warning in the log an hour later - the operator has to publish this port, so silently
 * getting a different one is worse than being refused.
 *
 * Changing it on a live exit node is deliberately allowed: the link is re-provisioned on the
 * next converge, which is exactly what an operator moving the port in their firewall wants.
 * Clearing it (null) hands the choice back to the allocator.
 */
async function resolveExitListenPort(current: Peer | null, request: PeerWriteRequest): Promise<{ ok: true; value: number | null } | { ok: false; failure: Failure }> {
	if (request.exitListenPort === undefined) return { ok: true, value: current?.exitListenPort ?? null };
	if (request.exitListenPort === null) return { ok: true, value: null };

	const port = request.exitListenPort;
	if (!Number.isInteger(port) || port < WG_LISTEN_PORT_MIN || port > WG_LISTEN_PORT_MAX) {
		return { ok: false, failure: failure(`exitListenPort must be between ${WG_LISTEN_PORT_MIN} and ${WG_LISTEN_PORT_MAX}`, 'exitListenPort') };
	}

	const taken = await loadExitLinkTaken(current?.id);
	if (taken.listenPorts.has(port)) return { ok: false, failure: failure(`Port ${port} is already in use by another interface`, 'exitListenPort') };

	return { ok: true, value: port };
}

/** The per-server state lib/peerInvariants.ts decides against. */
async function loadInvariantSnapshot(server: ServerPeer) {
	const [peers, tags] = await Promise.all([db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, server.id) }), db.query.peerTagsTable.findMany({ where: eq(peerTagsTable.serverPeerId, server.id), columns: { id: true } })]);

	return { peers, tagIds: tags.map((t) => t.id), serverIsExitNode: server.isExitNode };
}

/**
 * Validates a peer's advertised subnet routes and returns the normalised column value to store
 * (applied by wg/exitRouting.ts). Like the invariants above, wireguard and the kernel are what
 * break: a prefix has exactly one owner both in cryptokey routing on an interface and in the
 * host's main routing table, so a second claim on an overlapping range would silently steal
 * the first one's traffic instead of failing visibly.
 *
 * That second scope is why the snapshot handed to resolveAdvertisedRoutes is host-wide rather
 * than per-server: every *other* peer's advertisements plus every *other* interface's own
 * `cidrRange`, whose connected route an `ip route replace` would overwrite.
 */
async function resolveAdvertisedRoutesFor(server: ServerPeer, current: Peer | null, request: PeerWriteRequest): Promise<{ ok: true; value: string | null } | { ok: false; failure: Failure }> {
	if (request.advertisedRoutes === undefined) return { ok: true, value: current?.advertisedRoutes ?? null };

	const [allServers, allPeers] = await Promise.all([db.query.serverPeersTable.findMany(), db.query.peersTable.findMany()]);

	const interfaceOf = new Map(allServers.map((s) => [s.id, s.interfaceName]));

	const reserved = [
		...allServers.filter((s) => s.id !== server.id).map((s) => ({ label: `interface ${s.interfaceName}`, routes: [s.cidrRange] })),
		...allPeers
			.filter((p) => p.id !== current?.id)
			.map((p) => ({ label: p.serverPeerId === server.id ? (p.friendlyName ?? p.wgAddress) : `${p.friendlyName ?? p.wgAddress} on ${interfaceOf.get(p.serverPeerId) ?? p.serverPeerId}`, routes: advertisedRoutesOf(p) }))
			.filter((p) => p.routes.length > 0),
	];

	const resolved = resolveAdvertisedRoutes(request.advertisedRoutes, server.cidrRange, reserved);
	if (!resolved.ok) return resolved;

	// Stored comma-separated and network-aligned, so wg/config.ts, wg/exitRouting.ts and
	// wg/firewall.ts can all interpolate the entries verbatim. Null rather than '' for empty,
	// so "advertises nothing" is one value in the db instead of two.
	return { ok: true, value: resolved.routes.length ? resolved.routes.join(',') : null };
}
