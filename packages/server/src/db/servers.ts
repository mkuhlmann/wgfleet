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
