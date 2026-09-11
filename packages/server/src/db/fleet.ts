import { db } from './index';
import { serverPeersTable } from './schema';
import { asc } from 'drizzle-orm';
import { loadPolicyGraph, type PolicyGraph } from './policyGraph';

/**
 * Every server's policy graph, in a stable order - the single read of host-wide state.
 *
 * Both things this manager applies globally are functions of exactly this: the nft ruleset
 * (wg/firewall.ts, one `table inet wgmgr` across all servers) and the host's policy routing
 * (wg/exitRouting.ts, one main routing table). They used to load it independently with the
 * same query, so every converge issued the same N+1 twice and the two appliers could in
 * principle see different snapshots.
 *
 * The order matters and is not cosmetic: buildRuleset's ordinal `s{i}`/`s{i}t{j}` nft naming
 * depends on it. createdAt is a timestamp with second-ish resolution, so ties break by id to
 * keep it deterministic for servers created in the same tick.
 */
export async function loadFleet(): Promise<PolicyGraph[]> {
	const servers = await db.query.serverPeersTable.findMany({ orderBy: [asc(serverPeersTable.createdAt), asc(serverPeersTable.id)] });
	const graphs = await Promise.all(servers.map((s) => loadPolicyGraph(s.id)));

	return graphs.filter((g): g is PolicyGraph => !!g);
}
