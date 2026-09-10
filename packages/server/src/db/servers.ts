import { db } from './index';
import { serverPeersTable, type ServerPeer } from './schema';
import { eq, or } from 'drizzle-orm';

/**
 * Resolves a server by its id or its interfaceName - the one rule for "a server is
 * addressable either way" (used by every server-scoped route, the server-scoped auth
 * macro, and the policy graph loader), so routing and authorization can't disagree
 * about what a URL identifies. Returns undefined if neither matches - callers decide
 * how to report that (404, 401, ...).
 */
export async function resolveServer(idOrInterfaceName: string): Promise<ServerPeer | undefined> {
	return db.query.serverPeersTable.findFirst({
		where: or(eq(serverPeersTable.id, idOrInterfaceName), eq(serverPeersTable.interfaceName, idOrInterfaceName)),
	});
}

// Policy-routing table ids for exit-node traffic (see wg/exitRouting.ts) are allocated from
// this band. It sits clear of the kernel's reserved ids (0 unspec, 253 default, 254 main,
// 255 local) and of wg-quick's own 51820-based table numbering, so a route in one of our
// tables can never be confused for one somebody else put there.
export const EXIT_ROUTE_TABLE_MIN = 52000;
export const EXIT_ROUTE_TABLE_MAX = 52999;

/**
 * Lowest free routing-table id in the exit band, or undefined when the band is exhausted.
 * Allocated explicitly at server-create time rather than derived from an ordinal: the id has
 * to stay stable for the life of the interface, and an ordinal would renumber every surviving
 * server's table when one is deleted - under live traffic, silently retargeting another
 * interface's default route.
 */
export async function allocateRouteTableId(): Promise<number | undefined> {
	const rows = await db.select({ routeTableId: serverPeersTable.routeTableId }).from(serverPeersTable);
	const taken = new Set(rows.map((r) => r.routeTableId));

	for (let id = EXIT_ROUTE_TABLE_MIN; id <= EXIT_ROUTE_TABLE_MAX; id++) {
		if (!taken.has(id)) return id;
	}

	return undefined;
}
