import { EXIT_ROUTE_TABLE_MAX, EXIT_ROUTE_TABLE_MIN } from './exitLinks';
import { createLog } from '@server/lib/log';
import { applyExitRouting } from './shell';
import { exitTopology, type PolicyGraph } from '@server/db/policyGraph';

const log = createLog('wg:exitRouting');

/**
 * Exit-node routing: which wg interface a packet leaves through, and which clients get to use
 * it. Each exit node has an interface of its own (an exit link, wg/exitLinks.ts) whose single
 * peer owns `AllowedIPs = 0.0.0.0/0` - so once a packet is *on* that device wireguard knows
 * where to send it. Getting it onto the right device is this module's job, and it is a
 * source-based policy route per client:
 *
 *   ip -4 route replace default dev wgx0 table 52000     (once per exit link)
 *   ip -4 rule add from 10.0.0.3/32 table 52000          (once per client of that exit node)
 *   ip -4 rule add from 10.0.0.4/32 table 52001          (a client of a *different* exit node)
 *
 * Two clients on the same server landing in different tables is the whole of "any peer can
 * pick any exit node" - and it only works because the tables name different interfaces. A
 * single shared interface could not express it no matter what the routing said, since the peer
 * within an interface is chosen by destination address alone and every exit client has the
 * same destination.
 *
 * That `ip rule` is also the whole enforcement story. A peer without an exitPeerId has no rule,
 * so its internet-bound packets fall through to the main table and leave via a non-wg interface
 * with their vpn source address, which nothing masquerades and nothing can route a reply back
 * to (the hub is not a gateway - see wg/firewall.ts). It cannot reach any exit node's uplink by
 * hand-editing its own AllowedIPs, which is why `exitPeerId` can be both the permission and the
 * routing instruction.
 *
 * Rejected alternative: marking exit clients in nftables (`meta mark set`) and matching
 * `ip rule fwmark`, which would move all per-client churn into the atomically-replaced
 * ruleset. It couples exit routing to the independently-probed `firewall` capability axis
 * (see wg/shell.ts), so a host with real `network` but shimmed `firewall` would silently
 * lose exit routing. Per-client `ip rule` needs only the `network` axis.
 *
 * This module also owns the *other* half of the same story - the subnet routes a peer
 * advertises (`peers.advertisedRoutes`), which need the mirror-image mechanism:
 *
 *   ip -4 route replace 192.168.1.0/24 dev wg0 proto static     (main table, no ip rule)
 *
 * Destination-based, in the main table, with no per-client state at all - because the
 * permission for reaching an advertised LAN is an ordinary `dstKind: 'cidr'` grant in the
 * firewall, not the route. Both halves live here because both exist for the same reason
 * (`Table = off` means wg-quick installs no routes, so this manager installs them) and both
 * have to be applied after the device is up. An exit link's own `/32` route rides along for a
 * third variation on the same reason: its peer left the server's interface, so the connected
 * route that used to make it reachable no longer covers it.
 *
 * Like wg/firewall.ts this splits into a pure builder (buildExitRouting - no db, no io, what
 * exitRouting.test.ts drives) and a thin loader/applier.
 */
/**
 * One server's routing, as a set of interfaces. A server owns its own wg interface plus one
 * **exit link** per exit node (wg/exitLinks.ts), and each needs main-table routes; each link
 * additionally owns a policy table that its clients are steered into.
 */
type ExitRoutingServer = {
	/** the server's own wg interface - where every non-exit peer lives */
	interfaceName: string;
	/** the vpn subnet, reachable through the interface above */
	cidrRange: string;
	/**
	 * Main-table destinations this interface carries, all `proto static`: the subnets advertised
	 * by its ordinary peers. Already network-aligned and overlap-checked (wg/addressing.ts's
	 * resolveAdvertisedRoutes).
	 */
	staticRoutes: string[];
	exitLinks: ExitRoutingLink[];
};

type ExitRoutingLink = {
	interfaceName: string;
	/**
	 * The exit node's own `/32` - without it nothing on the host can reach that peer, since it
	 * left the server's interface and is no longer covered by its connected route.
	 */
	nodeRoute: string;
	/** subnets this exit node advertises, which live on its link rather than the server's */
	advertisedRoutes: string[];
	/** the policy table whose default route points at this link */
	routeTableId: number;
	/** ips of the peers assigned to this exit node */
	clientIps: string[];
};

/** Everything that goes in the main table for one interface, in one list. */
const staticRoutesOf = (link: ExitRoutingLink): string[] => [link.nodeRoute, ...link.advertisedRoutes];

// `ip rule` has no upsert and no "delete every rule for table N", so draining is a bounded
// delete-until-it-fails loop. Bounded rather than `while true` so a kernel that somehow keeps
// answering can't spin forever; 512 is far above any plausible peer count for one interface,
// and a leftover rule would only mean one client's traffic keeps using an exit path it was
// just removed from - visible, and corrected on the next sync.
const drainRules = (tableId: number) => `i=0; while [ $i -lt 512 ] && ip -4 rule del table ${tableId} 2>/dev/null; do i=$((i+1)); done`;

const flushRoutes = (tableId: number) => `ip -4 route flush table ${tableId} 2>/dev/null || true`;

/**
 * Routes in the **main** table cannot be flushed wholesale - so everything this manager puts
 * there is tagged `proto static` and only that proto is drained. Nothing else on a wg interface
 * carries it: the connected route from an interface's `Address` is `proto kernel`, and anything
 * `ip route add`ed without an explicit proto (including wg-quick's own routes, which
 * `Table = off` suppresses anyway) is `proto boot`. The tag is therefore this manager's marker
 * for "a route I put here", which is what lets the same full-reconcile-every-sync philosophy as
 * the exit tables below apply to a table it doesn't own: everything it added is removable
 * without a record of what it added.
 *
 * The per-exit-node tables need no such marker - they are ours entirely and get flushed whole.
 */
const STATIC_ROUTE_PROTO = 'static';

const flushStaticRoutes = (interfaceName: string) => `ip -4 route flush dev ${interfaceName} proto ${STATIC_ROUTE_PROTO} 2>/dev/null || true`;

const inBand = (tableId: number) => tableId >= EXIT_ROUTE_TABLE_MIN && tableId <= EXIT_ROUTE_TABLE_MAX;

/**
 * Pure command builder - no db, no io. Full reconcile rather than incremental add/delete,
 * mirroring the delete-then-recreate philosophy of wg/firewall.ts's ruleset: every table is
 * drained before it is repopulated, so the applied state is a function of the db alone and
 * can't drift no matter which mutation path got us here.
 *
 * Callers must pass the whole fleet, including servers with no exit nodes and nothing
 * advertised - that is how a table gets emptied after its exit node loses its last client, and
 * how a route left over from a withdrawn advertisement goes away.
 *
 * Takes the fleet snapshot rather than a pre-resolved projection for the same reason
 * buildRuleset does (wg/firewall.ts): the projection below is where the decisions are - which
 * exit node has a link, whose clients are whose, which advertisement sits on which interface -
 * and above the seam it was verified by nothing.
 */
export const buildExitRouting = (fleet: PolicyGraph[]): string[] => {
	const commands: string[] = [];

	for (const server of fleet.map(toExitRoutingServer)) {
		const interfaces = [{ interfaceName: server.interfaceName, staticRoutes: server.staticRoutes }, ...server.exitLinks.map((link) => ({ interfaceName: link.interfaceName, staticRoutes: staticRoutesOf(link) }))];

		// Main table first. Drained unconditionally - an interface with nothing on it is exactly
		// the case where a route left over from a removed advertisement has to go, and that is
		// not distinguishable from "never had one" without keeping state. Harmless where the
		// feature was never used (nothing carries proto static).
		for (const iface of interfaces) {
			commands.push(flushStaticRoutes(iface.interfaceName));

			for (const cidr of [...new Set(iface.staticRoutes)].sort()) {
				// `replace` rather than `add` because a changed interfaceName has to retarget the
				// existing route rather than error on a duplicate.
				commands.push(`ip -4 route replace ${cidr} dev ${iface.interfaceName} proto ${STATIC_ROUTE_PROTO}`);
			}
		}

		for (const link of server.exitLinks) {
			// Defensive: a routeTableId outside the allocated band means the row was written
			// directly or predates the band. Touching an arbitrary table number could clobber
			// routing this manager doesn't own, so skip the table entirely - the main-table
			// routes above need no table and are unaffected.
			if (!inBand(link.routeTableId)) continue;

			commands.push(drainRules(link.routeTableId));

			const clientIps = [...new Set(link.clientIps)].sort();

			if (clientIps.length === 0) {
				commands.push(flushRoutes(link.routeTableId));
				continue;
			}

			// An exit client's rule captures *all* of its traffic, so this table has to be a
			// complete routing table and not just a default route - otherwise a client would
			// reach the internet but lose every one of its peers, its hub and every advertised
			// LAN, all of which live on interfaces this link is not. Cheap to state fully, and
			// it keeps the table a pure function of the snapshot rather than something that
			// leans on the main table falling through.
			commands.push(`ip -4 route replace ${server.cidrRange} dev ${server.interfaceName} table ${link.routeTableId}`);

			for (const iface of interfaces) {
				for (const cidr of [...new Set(iface.staticRoutes)].sort()) {
					commands.push(`ip -4 route replace ${cidr} dev ${iface.interfaceName} table ${link.routeTableId}`);
				}
			}

			// Last and least specific. Requires the device to exist, which is why
			// the plan puts the interface steps ahead of the routing for exactly this reason.
			commands.push(`ip -4 route replace default dev ${link.interfaceName} table ${link.routeTableId}`);

			for (const ip of clientIps) {
				commands.push(`ip -4 rule add from ${ip}/32 table ${link.routeTableId}`);
			}
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

/**
 * One server's interfaces, flattened: its own plus one per provisioned exit node. Same
 * derivation the configs and the nft ruleset use - see lib/exitTopology.ts - so all three
 * always agree on which peer lives on which interface.
 *
 * Only clients pointing at an exit node *of this server* count, which that projection already
 * guarantees: exitPeerId is api-validated to name a peer on the same server, but a stale id
 * must not silently route a client into a table whose default route belongs to somebody else's
 * uplink.
 */
const toExitRoutingServer = (graph: PolicyGraph): ExitRoutingServer => {
	const topology = exitTopology(graph);

	return {
		interfaceName: graph.server.interfaceName,
		cidrRange: graph.server.cidrRange,
		staticRoutes: topology.interfaceAdvertisedRoutes,
		exitLinks: topology.exitNodes.flatMap((node) =>
			node.link
				? [
						{
							interfaceName: node.link.interfaceName,
							// Its server's connected route no longer covers this peer (it is not on that
							// interface any more), so without this nothing on the host - and therefore no
							// other peer - can reach it at all.
							nodeRoute: `${node.ip}/32`,
							advertisedRoutes: node.advertisedRoutes,
							routeTableId: node.link.routeTableId,
							clientIps: node.clientIps,
						},
					]
				: [],
		),
	};
};

/**
 * Which interfaces need which host-level sysctl warning, as data. Pure, so the rule "an exit
 * link with no clients still needs the rp_filter warning if its node advertises" is a fixture
 * rather than a branch nobody can reach from a test - `readSysctl` below touches the real
 * /proc, so everything that decided *whether* to read it used to be untestable with it.
 *
 * `forwarding` is a list of reasons; empty means nothing on this host forwards at all, and the
 * ip_forward check is skipped entirely rather than warning a plain hub-only deployment.
 */
export const buildExitRoutingChecks = (fleet: PolicyGraph[]): { reversePath: { interfaceName: string; reason: string }[]; forwarding: string[] } => {
	const reversePath: { interfaceName: string; reason: string }[] = [];
	const forwarding: string[] = [];

	const ADVERTISES = 'has a peer advertising subnet routes';

	for (const server of fleet.map(toExitRoutingServer)) {
		if (server.staticRoutes.length) {
			reversePath.push({ interfaceName: server.interfaceName, reason: ADVERTISES });
			forwarding.push(`${server.interfaceName} has advertised subnet routes`);
		}

		for (const link of server.exitLinks) {
			const advertises = link.advertisedRoutes.length > 0;

			if (link.clientIps.length) {
				reversePath.push({ interfaceName: link.interfaceName, reason: 'is an exit node link' });
				forwarding.push(`${link.interfaceName} routes ${link.clientIps.length} client(s) through an exit node`);
			} else if (advertises) {
				reversePath.push({ interfaceName: link.interfaceName, reason: ADVERTISES });
			}

			if (advertises) forwarding.push(`${link.interfaceName} has advertised subnet routes`);
		}
	}

	return { reversePath, forwarding };
};

/** A /proc/sys integer, or null where /proc isn't readable (container, non-linux). */
const readSysctl = async (path: string): Promise<number | null> => {
	try {
		const file = Bun.file(`/proc/sys/${path}`);
		if (!(await file.exists())) return null;

		const value = Number.parseInt((await file.text()).trim(), 10);
		return Number.isNaN(value) ? null : value;
	} catch {
		return null;
	}
};

/**
 * Strict reverse-path filtering silently breaks an otherwise-correct exit node: replies come
 * back from the exit node with an internet source address on the wg interface, and with
 * rp_filter=1 the kernel drops them because that source routes via the host's own uplink.
 * Loose (2) or off (0) is required. Advertised subnet routes have exactly the same problem
 * for exactly the same reason - a reply from 192.168.1.x arrives on wg0 while the host's own
 * table may route that source elsewhere - so an advertisement-only interface needs the same
 * warning. This isn't something this manager should silently change on the host's behalf - so
 * warn loudly and leave it to the operator.
 *
 * The effective setting is `max(conf.all.rp_filter, conf.<iface>.rp_filter)`, not the
 * per-interface value alone - a host with `all = 1` filters strictly no matter what wg0 says,
 * which is exactly the configuration this check used to declare healthy.
 */
const warnOnStrictReversePath = async (interfaceName: string, reason: string) => {
	const [all, iface] = await Promise.all([readSysctl('net/ipv4/conf/all/rp_filter'), readSysctl(`net/ipv4/conf/${interfaceName}/rp_filter`)]);
	if (all === null && iface === null) return;

	if (Math.max(all ?? 0, iface ?? 0) === 1) {
		log.warn(
			`Reverse-path filtering is strict for ${interfaceName} (net.ipv4.conf.all.rp_filter=${all ?? '?'}, net.ipv4.conf.${interfaceName}.rp_filter=${iface ?? '?'}) and this interface ${reason} - the replies will be dropped. Set both to 2 (loose) or 0.`,
		);
	}
};

/**
 * Both features in this module are *forwarding*: a packet arrives on a wg interface addressed
 * to somewhere else - the exit node, or a LAN behind an advertiser - and the host has to put
 * it back out. With `net.ipv4.ip_forward = 0` the kernel drops it silently, and every visible
 * symptom looks healthy: the handshake is live, `ip rule`/`ip route` are exactly right, the
 * nft ruleset accepts. The only signal is that the client times out.
 *
 * Checked host-wide (the sysctl is), and only once something actually needs forwarding, so a
 * plain hub-only deployment - where nothing is forwarded and the setting is irrelevant - stays
 * silent. Like rp_filter above this is the operator's to set, not ours to change underneath
 * them: the container needs `--sysctl net.ipv4.ip_forward=1`, a bare host a sysctl.d drop-in.
 */
const warnOnForwardingDisabled = async (reasons: string[]) => {
	if (reasons.length === 0) return;

	const value = await readSysctl('net/ipv4/ip_forward');
	if (value === null || value !== 0) return;

	log.warn(`net.ipv4.ip_forward is 0 on this host, but ${reasons.join(' and ')} - nothing will be forwarded and those clients will simply time out. Set it to 1 (container: --sysctl net.ipv4.ip_forward=1).`);
};

/**
 * Emits the sysctl warnings a plan calls for. The *deciding* is pure (buildExitRoutingChecks
 * above); this only reads /proc and logs, which is why the two are separate at all.
 */
export const warnOnRoutingSysctls = async (checks: { reversePath: { interfaceName: string; reason: string }[]; forwarding: string[] }) => {
	for (const check of checks.reversePath) {
		await warnOnStrictReversePath(check.interfaceName, check.reason);
	}
	await warnOnForwardingDisabled(checks.forwarding);
};

export const resetExitRouting = async (tableIds: number[]) => {
	try {
		await applyExitRouting(buildExitRoutingTeardown(tableIds));
	} catch (error) {
		log.error(`Failed to tear down exit routing: ${error}`);
	}
};
