import { db } from '@server/db';
import { peersTable, serverPeersTable, type Peer } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { createLog } from '@server/lib/log';
import { wgDerivePublicKey, wgGenKey } from './shell';

const log = createLog('wg:exitLinks');

/**
 * An **exit link** is the wg interface a single exit node gets to itself on the hub.
 *
 * Why an interface each rather than one shared one: wireguard picks which peer to encrypt a
 * packet to from the packet's *destination address* alone (cryptokey routing), and every exit
 * client wants the same destination - the whole internet, `0.0.0.0/0`. That prefix has exactly
 * one owner per interface, and writing it to a second peer does not fail, it silently takes it
 * away from the first. So N exit nodes on one interface cannot work at all; N interfaces with
 * one peer each have nothing to compete over. Per-client choice then becomes an ordinary
 * routing question - `ip rule from <client> table <that exit node's table>`, wg/exitRouting.ts.
 *
 * The cost, and the reason the ui states it so loudly: each link needs its own **UDP port on
 * the hub**, reachable from the exit node's machine, because the exit node is the one that
 * dials in. Nothing else about a client changes - same key, same address, same endpoint, same
 * two config files.
 *
 * Allocation is *reconciled*, not done in the write path: `reconcileExitLinks` runs at the
 * start of every converge and provisions any `isExitNode` peer that has no link, releasing the
 * links of peers that are no longer exit nodes. That way a row that became an exit node by a
 * path that never touched the peer api - a policy import, a direct db write, or the schema
 * migration that added these columns to an install that already had one - still ends up with
 * a working interface instead of silently doing nothing.
 */

// Exit links are named by an allocated ordinal rather than after their server or their peer:
// `interfaceName` is capped at 15 chars (IFNAMSIZ) and peer ids are nanoids, neither of which
// composes into a name that is both unique and short. The number is stored, so renaming a
// server or deleting another exit node never renumbers a live interface.
const EXIT_INTERFACE_PREFIX = 'wgx';

/** Is this the name of an interface this module would have allocated? See sweepOrphanedExitLinks. */
export const isExitLinkInterface = (interfaceName: string) => new RegExp(`^${EXIT_INTERFACE_PREFIX}\\d+$`).test(interfaceName);

// Its own UDP port, allocated from a band that sits above wg-quick's conventional 51820 so an
// auto-allocated link never collides with a hand-configured server. An operator who needs a
// specific port (a firewall that only permits certain ranges, say) can pin one per exit node -
// see PEER_WRITE_BODY's exitListenPort in api/serversPeers.ts.
export const EXIT_LISTEN_PORT_MIN = 51900;
export const EXIT_LISTEN_PORT_MAX = 51999;

// Policy-routing table ids for exit-node traffic (see wg/exitRouting.ts). The band sits clear
// of the kernel's reserved ids (0 unspec, 253 default, 254 main, 255 local) and of wg-quick's
// own 51820-based table numbering, so a route in one of our tables can never be confused for
// one somebody else put there.
export const EXIT_ROUTE_TABLE_MIN = 52000;
export const EXIT_ROUTE_TABLE_MAX = 52999;

export type ExitLinkAllocation = { interfaceName: string; listenPort: number; routeTableId: number };

export type ExitLinkTaken = {
	/** every interface name in use on this host - server interfaces and other exit links alike */
	interfaceNames: Set<string>;
	/** every udp port in use - server listen ports and other exit links alike */
	listenPorts: Set<number>;
	routeTableIds: Set<number>;
};

const lowestFree = (min: number, max: number, taken: Set<number>): number | undefined => {
	for (let value = min; value <= max; value++) {
		if (!taken.has(value)) return value;
	}
	return undefined;
};

/**
 * Lowest free interface name, port and routing table, or a message naming whichever ran out.
 * Pure - `taken` is a pre-fetched snapshot, never queried here.
 *
 * `preferredPort` is an operator-pinned port: it is used as-is when free, and refused rather
 * than silently replaced when not, since a caller that asked for a specific port did so because
 * something outside this system (a published container port, a firewall rule) already names it.
 */
export function allocateExitLink(taken: ExitLinkTaken, preferredPort?: number | null): { ok: true; allocation: ExitLinkAllocation } | { ok: false; message: string } {
	const ordinal = lowestFree(0, 9999, new Set([...taken.interfaceNames].flatMap((name) => (name.startsWith(EXIT_INTERFACE_PREFIX) ? [Number.parseInt(name.slice(EXIT_INTERFACE_PREFIX.length), 10)] : []))));
	if (ordinal === undefined) return { ok: false, message: 'No free exit-link interface name available' };

	const interfaceName = `${EXIT_INTERFACE_PREFIX}${ordinal}`;
	// The ordinal search only looked at wgx-shaped names; a server called `wgx0` by hand would
	// otherwise be shadowed by a link with the same name.
	if (taken.interfaceNames.has(interfaceName)) return { ok: false, message: `Interface name ${interfaceName} is already in use` };

	let listenPort: number | undefined;
	if (preferredPort !== undefined && preferredPort !== null) {
		if (taken.listenPorts.has(preferredPort)) return { ok: false, message: `Port ${preferredPort} is already in use by another interface` };
		listenPort = preferredPort;
	} else {
		listenPort = lowestFree(EXIT_LISTEN_PORT_MIN, EXIT_LISTEN_PORT_MAX, taken.listenPorts);
	}
	if (listenPort === undefined) return { ok: false, message: `No free udp port in the exit-link band (${EXIT_LISTEN_PORT_MIN}-${EXIT_LISTEN_PORT_MAX}) - pin one explicitly instead` };

	const routeTableId = lowestFree(EXIT_ROUTE_TABLE_MIN, EXIT_ROUTE_TABLE_MAX, taken.routeTableIds);
	if (routeTableId === undefined) return { ok: false, message: 'No free policy-routing table id available for another exit node' };

	return { ok: true, allocation: { interfaceName, listenPort, routeTableId } };
}

/** Everything on this host that an exit link would have to avoid colliding with. */
export async function loadExitLinkTaken(excludePeerId?: string): Promise<ExitLinkTaken> {
	const [servers, peers] = await Promise.all([
		db.select({ interfaceName: serverPeersTable.interfaceName, wgListenPort: serverPeersTable.wgListenPort }).from(serverPeersTable),
		db.select({ id: peersTable.id, exitInterfaceName: peersTable.exitInterfaceName, exitListenPort: peersTable.exitListenPort, exitRouteTableId: peersTable.exitRouteTableId }).from(peersTable),
	]);

	const others = peers.filter((p) => p.id !== excludePeerId);

	return {
		interfaceNames: new Set([...servers.map((s) => s.interfaceName), ...others.map((p) => p.exitInterfaceName).filter((n): n is string => !!n)]),
		listenPorts: new Set([...servers.map((s) => s.wgListenPort), ...others.map((p) => p.exitListenPort).filter((p): p is number => p !== null)]),
		routeTableIds: new Set(others.map((p) => p.exitRouteTableId).filter((t): t is number => t !== null)),
	};
}

export type ExitLinkReconcile = {
	/** interfaces that no longer belong to an exit node and have to be torn down */
	releasedInterfaces: string[];
	/** routing tables that went with them */
	releasedRouteTableIds: number[];
	/**
	 * interfaces allocated by *this* reconcile, carrying a brand new keypair and udp port. A
	 * name freed by a crash can come straight back here while the device is still up, and
	 * reloading (`wg syncconf`) applies the peers but not the `[Interface]` half - so converge
	 * has to restart these rather than reload them. See wg/plan.ts.
	 */
	provisionedInterfaces: string[];
	/** peers that wanted a link but could not get one - reported, never thrown */
	failures: { peerId: string; message: string }[];
};

/**
 * Brings this server's exit links in line with which of its peers carry `isExitNode`.
 * Allocates and generates a keypair for every exit node without a link, and clears the columns
 * of every peer that has one but is no longer an exit node.
 *
 * Never throws: a server whose links cannot all be provisioned must still converge the rest of
 * itself, exactly like the appliers converge runs afterwards. The affected exit node stays inert
 * (its link is null everywhere downstream) and is reported back so converge can log it.
 */
export async function reconcileExitLinks(serverPeerId: string): Promise<ExitLinkReconcile> {
	const peers = await db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, serverPeerId) });

	const result: ExitLinkReconcile = { releasedInterfaces: [], releasedRouteTableIds: [], provisionedInterfaces: [], failures: [] };

	for (const peer of peers) {
		if (!peer.isExitNode && peer.exitInterfaceName) {
			result.releasedInterfaces.push(peer.exitInterfaceName);
			if (peer.exitRouteTableId !== null) result.releasedRouteTableIds.push(peer.exitRouteTableId);

			await db.update(peersTable).set(CLEARED_LINK).where(eq(peersTable.id, peer.id)).execute();
			log.info(`Released exit link ${peer.exitInterfaceName} from peer ${peer.id}`);
			continue;
		}

		if (peer.isExitNode && !isProvisioned(peer)) {
			// Re-read the taken set per peer rather than once up front: two exit nodes created in
			// the same converge must not be handed the same ordinal.
			const allocation = allocateExitLink(await loadExitLinkTaken(peer.id), peer.exitListenPort);
			if (!allocation.ok) {
				result.failures.push({ peerId: peer.id, message: allocation.message });
				log.error(`Cannot provision an exit link for peer ${peer.id}: ${allocation.message}`);
				continue;
			}

			const privateKey = await wgGenKey();
			await db
				.update(peersTable)
				.set({
					exitInterfaceName: allocation.allocation.interfaceName,
					exitListenPort: allocation.allocation.listenPort,
					exitRouteTableId: allocation.allocation.routeTableId,
					exitPrivateKey: privateKey,
					exitPublicKey: await wgDerivePublicKey(privateKey),
				})
				.where(eq(peersTable.id, peer.id))
				.execute();

			result.provisionedInterfaces.push(allocation.allocation.interfaceName);
			log.info(`Provisioned exit link ${allocation.allocation.interfaceName} (udp ${allocation.allocation.listenPort}) for peer ${peer.id}`);
		}
	}

	return result;
}

const CLEARED_LINK = {
	exitInterfaceName: null,
	exitListenPort: null,
	exitRouteTableId: null,
	exitPrivateKey: null,
	exitPublicKey: null,
} as const;

// All five columns or none - a partially written link (a name but no key, say) would render a
// config wireguard rejects, so treat it as unprovisioned and let the reconcile redo it.
const isProvisioned = (peer: Peer) => !!peer.exitInterfaceName && !!peer.exitPrivateKey && !!peer.exitPublicKey && peer.exitListenPort !== null && peer.exitRouteTableId !== null;

/**
 * Every exit-link interface and routing table the db describes - for wg/manager.ts, which
 * needs them at boot (to merge each link's `wg show` samples into its server's) and at
 * shutdown (to take them down and clear their rules). `ip rule` entries outlive their
 * interface, so they need clearing explicitly even though deleting the device drops its routes.
 */
export async function allExitLinks(): Promise<{ interfaceName: string; routeTableId: number; serverPeerId: string }[]> {
	const peers = await db.query.peersTable.findMany({ columns: { exitInterfaceName: true, exitRouteTableId: true, serverPeerId: true } });

	return peers.flatMap((p) => (p.exitInterfaceName && p.exitRouteTableId !== null ? [{ interfaceName: p.exitInterfaceName, routeTableId: p.exitRouteTableId, serverPeerId: p.serverPeerId }] : []));
}
