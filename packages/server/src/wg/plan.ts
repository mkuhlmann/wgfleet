import type { PolicyGraph } from '@server/db/policyGraph';
import { exitTopologyOf } from '@server/lib/exitTopology';
import { isExitLinkInterface, type ExitLinkReconcile } from './exitLinks';
import { buildServerConfig, generateExitLinkConfig } from './config';
import { buildRuleset } from './firewall';
import { buildExitRouting, buildExitRoutingChecks } from './exitRouting';

/**
 * What one converge is going to do, as data.
 *
 * Converge used to carry five load-bearing ordering constraints as prose - released links go
 * down before anything comes up; exit links are allocated before any config is rendered; the
 * routing runs after every interface exists; the sweep runs here rather than there - and the
 * types involved were `Promise<void>` and `PolicyGraph[]`, which say none of it. One of those
 * constraints was restated in four separate comments, which is the tell: nothing enforced it,
 * so it was re-documented wherever somebody feared it would be forgotten.
 *
 * Here the order *is* the plan: `interfaces` is applied front to back, then the host-wide half.
 * Deciding is pure and takes one fleet snapshot plus one look at the host, so the decisions -
 * including start-vs-reload, which used to be a per-interface probe - are testable without a
 * host at all.
 */
export type ConvergePlan = {
	/** applied in order: stops first, so a name or udp port freed here is reusable below */
	interfaces: InterfaceStep[];
	/** drained before the host-wide routing is rebuilt - the tables of released exit links */
	drainRouteTableIds: number[];
	/** the whole `table inet wgmgr` script, across every server */
	ruleset: string;
	/** the host's policy routing, across every server */
	routing: string[];
	/** sysctl warnings this state calls for - see buildExitRoutingChecks */
	routingChecks: ReturnType<typeof buildExitRoutingChecks>;
};

export type InterfaceStep = { action: 'stop'; interfaceName: string; reason: 'released' | 'orphaned' } | { action: 'start' | 'reload' | 'restart'; interfaceName: string; config: string };

export type ConvergeInput = {
	/** the server whose interfaces this converge owns; the host-wide half always spans the fleet */
	serverId: string;
	/** one read of every server's policy graph, taken *after* reconcileExitLinks wrote its columns */
	fleet: PolicyGraph[];
	/** every wireguard interface currently up on the host (`listInterfaces`) */
	upInterfaces: string[];
	reconcile: ExitLinkReconcile;
};

/**
 * Start it, reload it, or restart it.
 *
 * `restart` exists for one case that a reload silently gets wrong: an interface that is up but
 * whose *identity* just changed. `wg syncconf` applies the peer list and nothing in
 * `[Interface]`, so a freshly provisioned exit link that inherited a crashed predecessor's name
 * would keep running the dead link's private key and udp port - looking healthy, and reachable
 * by nobody. Stopping first is the only way to apply the new one.
 */
const applyStep = (interfaceName: string, config: string, up: Set<string>, reprovisioned: Set<string>): InterfaceStep => {
	if (!up.has(interfaceName)) return { action: 'start', interfaceName, config };
	return { action: reprovisioned.has(interfaceName) ? 'restart' : 'reload', interfaceName, config };
};

export const planConverge = (input: ConvergeInput): ConvergePlan => {
	const { fleet, reconcile } = input;
	const up = new Set(input.upInterfaces);
	const provisioned = new Set(reconcile.provisionedInterfaces);

	const graph = fleet.find((g) => g.server.id === input.serverId);

	const interfaces: InterfaceStep[] = [];
	const stopping = new Set<string>();

	// Down first, so a name or udp port freed here can be reused by a start below within this
	// same plan.
	for (const interfaceName of reconcile.releasedInterfaces) {
		if (!up.has(interfaceName) || stopping.has(interfaceName)) continue;
		stopping.add(interfaceName);
		interfaces.push({ action: 'stop', interfaceName, reason: 'released' });
	}

	// Exit links the db no longer describes at all. reconcileExitLinks releases the link of a
	// peer that stopped being an exit node, but it cannot see one whose peer row was deleted
	// while this process was down - and the configs and the ruleset would then go on ignoring a
	// live interface that still owns `0.0.0.0/0`.
	//
	// Only ever `wgx`-shaped names that no server and no exit node claims, so an interface
	// somebody else on this host manages - including a server that happens to be named like a
	// link - is never a candidate. Planned here, before anything starts, rather than swept at
	// the end: an orphan that is about to have its name handed to a new link has to be gone
	// before that link comes up.
	const claimed = new Set(fleet.flatMap((g) => [g.server.interfaceName, ...exitTopologyOf(g.peers).exitNodes.flatMap((node) => (node.link ? [node.link.interfaceName] : []))]));

	for (const interfaceName of input.upInterfaces) {
		if (!isExitLinkInterface(interfaceName) || claimed.has(interfaceName) || stopping.has(interfaceName)) continue;
		stopping.add(interfaceName);
		interfaces.push({ action: 'stop', interfaceName, reason: 'orphaned' });
	}

	// Anything stopped above is no longer up for the start-vs-reload decisions below.
	for (const interfaceName of stopping) up.delete(interfaceName);

	// A server that vanished between the mutation and this plan (deleted concurrently) still
	// gets the host-wide half rebuilt from the fleet without it, which is exactly right.
	if (graph) {
		interfaces.push(applyStep(graph.server.interfaceName, buildServerConfig(graph), up, provisioned));

		for (const node of exitTopologyOf(graph.peers).exitNodes) {
			// unprovisioned link - reconcileExitLinks already reported why
			if (!node.link) continue;
			interfaces.push(applyStep(node.link.interfaceName, generateExitLinkConfig(node), up, provisioned));
		}
	}

	return {
		interfaces,
		drainRouteTableIds: reconcile.releasedRouteTableIds,
		ruleset: buildRuleset(fleet),
		routing: buildExitRouting(fleet),
		routingChecks: buildExitRoutingChecks(fleet),
	};
};
