import { db } from '@server/db';
import { serverPeersTable } from '@server/db/schema';
import { EXIT_ROUTE_TABLE_MAX, EXIT_ROUTE_TABLE_MIN } from '@server/db/servers';
import { createLog } from '@server/lib/log';
import { asc } from 'drizzle-orm';
import { applyExitRouting } from './shell';
import { loadPolicyGraph, type PolicyGraph } from '@server/db/policyGraph';

const log = createLog('wg:exitRouting');

/**
 * Exit-node routing. A peer marked `isExitNode` owns `AllowedIPs = 0.0.0.0/0` on the server
 * side (see wg/config.ts), which is what lets wireguard *encrypt* internet-bound traffic to
 * it - but the kernel still has to *route* that traffic to the wg interface in the first
 * place, and the main table sends it out the host's own uplink instead. So for every peer
 * whose `exitPeerId` names the exit node we install a source-based policy route:
 *
 *   ip -4 route replace default dev wg0 table 52000     (once per interface)
 *   ip -4 rule add from 10.0.0.3/32 table 52000         (once per exit client)
 *
 * That `ip rule` is the whole enforcement story for this feature. A peer without an
 * exitPeerId has no rule, so its internet-bound packets fall through to the main table,
 * leave via a non-wg interface and are dropped by the egress guard in wg/firewall.ts. It
 * cannot reach the exit node's uplink by hand-editing its own AllowedIPs, which is why
 * `exitPeerId` can be both the permission and the routing instruction.
 *
 * Rejected alternative: marking exit clients in nftables (`meta mark set`) and matching
 * `ip rule fwmark`, which would move all per-client churn into the atomically-replaced
 * ruleset. It couples exit routing to the independently-probed `firewall` capability axis
 * (see wg/shell.ts), so a host with real `network` but shimmed `firewall` would silently
 * lose exit routing. Per-client `ip rule` needs only the `network` axis.
 *
 * Like wg/firewall.ts this splits into a pure builder (buildExitRouting - no db, no io, what
 * exitRouting.test.ts drives) and a thin loader/applier.
 */
export type ExitRoutingServer = {
	interfaceName: string;
	routeTableId: number;
	// null when this server has no exit node - the table is then drained and left empty
	exitPeerIp: string | null;
	// ips of the peers whose exitPeerId names that exit node
	clientIps: string[];
};

// `ip rule` has no upsert and no "delete every rule for table N", so draining is a bounded
// delete-until-it-fails loop. Bounded rather than `while true` so a kernel that somehow keeps
// answering can't spin forever; 512 is far above any plausible peer count for one interface,
// and a leftover rule would only mean one client's traffic keeps using an exit path it was
// just removed from - visible, and corrected on the next sync.
const drainRules = (tableId: number) => `i=0; while [ $i -lt 512 ] && ip -4 rule del table ${tableId} 2>/dev/null; do i=$((i+1)); done`;

const flushRoutes = (tableId: number) => `ip -4 route flush table ${tableId} 2>/dev/null || true`;

/**
 * Pure command builder - no db, no io. Full reconcile rather than incremental add/delete,
 * mirroring the delete-then-recreate philosophy of wg/firewall.ts's ruleset: every table is
 * drained before it is repopulated, so the applied state is a function of the db alone and
 * can't drift no matter which mutation path got us here.
 *
 * Callers must pass every server that has a routing table allocated, including ones with no
 * exit node - that is how a table gets emptied after its exit node is unmarked.
 */
export const buildExitRouting = (servers: ExitRoutingServer[]): string[] => {
	const commands: string[] = [];

	for (const server of servers) {
		// Defensive: a routeTableId outside the allocated band means the row predates the
		// column's backfill or was written directly. Touching an arbitrary table number could
		// clobber routing this manager doesn't own, so skip the server entirely.
		if (server.routeTableId < EXIT_ROUTE_TABLE_MIN || server.routeTableId > EXIT_ROUTE_TABLE_MAX) continue;

		commands.push(drainRules(server.routeTableId));

		const clientIps = [...new Set(server.clientIps)].sort();

		if (!server.exitPeerIp || clientIps.length === 0) {
			commands.push(flushRoutes(server.routeTableId));
			continue;
		}

		// `replace` rather than `add` so a changed interfaceName overwrites the old default
		// route instead of erroring on a duplicate. Requires the device to exist, which is why
		// syncExitRouting runs at the end of converge(), after the interface is up.
		commands.push(`ip -4 route replace default dev ${server.interfaceName} table ${server.routeTableId}`);

		for (const ip of clientIps) {
			commands.push(`ip -4 rule add from ${ip}/32 table ${server.routeTableId}`);
		}
	}

	return commands;
};

/**
 * Teardown for a set of routing tables - used when a server is deleted (its table id is about
 * to become unreachable from the db, so it has to be cleaned before the row goes) and on
 * manager shutdown. `ip rule` entries outlive the interface: deleting the device drops the
 * table's routes with it, but the rules pointing at that table stay behind.
 */
export const buildExitRoutingTeardown = (tableIds: number[]): string[] => tableIds.filter((id) => id >= EXIT_ROUTE_TABLE_MIN && id <= EXIT_ROUTE_TABLE_MAX).flatMap((id) => [drainRules(id), flushRoutes(id)]);

const toExitRoutingServer = (graph: PolicyGraph): ExitRoutingServer => {
	const exitPeer = graph.peers.filter((p) => p.isExitNode).sort((a, b) => a.id.localeCompare(b.id))[0];

	// Only clients pointing at *this* server's exit node count. exitPeerId is api-validated to
	// name a peer on the same server, but a stale id must not silently route a client into a
	// table whose default route belongs to a different interface.
	const clientIps = exitPeer ? graph.peers.filter((p) => p.exitPeerId === exitPeer.id && p.id !== exitPeer.id).map((p) => p.wgAddress) : [];

	return {
		interfaceName: graph.server.interfaceName,
		routeTableId: graph.server.routeTableId,
		exitPeerIp: exitPeer?.wgAddress ?? null,
		clientIps,
	};
};

const loadExitRoutingState = async (): Promise<ExitRoutingServer[]> => {
	const servers = await db.query.serverPeersTable.findMany({ orderBy: [asc(serverPeersTable.createdAt), asc(serverPeersTable.id)] });
	const graphs = await Promise.all(servers.map((s) => loadPolicyGraph(s.id)));

	return graphs.filter((g): g is PolicyGraph => !!g).map(toExitRoutingServer);
};

/**
 * Strict reverse-path filtering silently breaks an otherwise-correct exit node: replies come
 * back from the exit node with an internet source address on the wg interface, and with
 * rp_filter=1 the kernel drops them because that source routes via the host's own uplink.
 * Loose (2) or off (0) is required. This is the single most likely reason a correct setup
 * looks broken, and it isn't something this manager should silently change on the host's
 * behalf - so warn loudly and leave it to the operator.
 */
const warnOnStrictReversePath = async (interfaceName: string) => {
	try {
		const file = Bun.file(`/proc/sys/net/ipv4/conf/${interfaceName}/rp_filter`);
		if (!(await file.exists())) return;

		if ((await file.text()).trim() === '1') {
			log.warn(`net.ipv4.conf.${interfaceName}.rp_filter is 1 (strict) and this interface has an exit node - replies from the exit node will be dropped. Set it to 2 (loose) or 0.`);
		}
	} catch {
		// unreadable /proc (container, non-linux) - nothing to warn about we can be sure of
	}
};

export const generateExitRouting = async () => buildExitRouting(await loadExitRoutingState());

/**
 * Brings the host's policy routing in sync with the db. Never throws - a failure here leaves
 * exit clients without internet but must not fail the mutation that triggered it or take the
 * interface down with it, matching syncFirewall's contract.
 */
export const syncExitRouting = async () => {
	try {
		const servers = await loadExitRoutingState();
		await applyExitRouting(buildExitRouting(servers));

		for (const server of servers) {
			if (server.exitPeerIp) await warnOnStrictReversePath(server.interfaceName);
		}
	} catch (error) {
		log.error(`Failed to apply exit routing: ${error}`);
	}
};

export const resetExitRouting = async (tableIds: number[]) => {
	try {
		await applyExitRouting(buildExitRoutingTeardown(tableIds));
	} catch (error) {
		log.error(`Failed to tear down exit routing: ${error}`);
	}
};
