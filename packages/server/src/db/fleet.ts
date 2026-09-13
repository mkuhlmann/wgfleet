import { db } from './index';
import { serverPeersTable } from './schema';
import { asc } from 'drizzle-orm';
import { policyGraphOf, type PolicyGraph } from './policyGraph';

/**
 * Every server's policy graph, in a stable order - the single read of host-wide state.
 *
 * Everything one converge applies is a function of exactly this: the nft ruleset
 * (wg/firewall.ts, one `table inet wgmgr` across all servers), the host's policy routing
 * (wg/exitRouting.ts, one main routing table) and each interface's own config (wg/config.ts).
 * wg/plan.ts reads it once and derives all three, so they cannot disagree - each used to load
 * what it needed itself, which meant four reads of the same rows per converge and no guarantee
 * they saw the same state.
 *
 * The order matters and is not cosmetic: buildRuleset's ordinal `s{i}`/`s{i}t{j}` nft naming
 * depends on it. createdAt is a timestamp with second-ish resolution, so ties break by id to
 * keep it deterministic for servers created in the same tick.
 */
export async function loadFleet(): Promise<PolicyGraph[]> {
	const servers = await db.query.serverPeersTable.findMany({ orderBy: [asc(serverPeersTable.createdAt), asc(serverPeersTable.id)] });

	// policyGraphOf rather than loadPolicyGraph: the rows are already in hand, so re-resolving
	// each one by id would be a second read per server for an answer we have.
	return Promise.all(servers.map(policyGraphOf));
}
