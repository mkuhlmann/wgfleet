import { db } from '@server/db';
import { peersTable } from '@server/db/schema';
import { eq } from 'drizzle-orm';
import { resolveServer } from '@server/db/servers';
import { loadFleet } from '@server/db/fleet';
import { isInterfaceUp, listInterfaces, reloadInterface, startInterface, stopInterface } from './shell';
import { syncFirewall } from './firewall';
import { resetExitRouting, syncExitRouting } from './exitRouting';
import { generateExitLinkConfig, generateServerConfig } from './config';
import { exitTopologyOf } from '@server/lib/exitTopology';
import { isExitLinkInterface, reconcileExitLinks } from './exitLinks';
import { createLog } from '@server/lib/log';

const log = createLog('wg:converge');

export type ConvergeResult = { ok: true } | { ok: false; reason: string };

// Serializes converge calls globally - wg-quick's temp-config-file scheme (shell.real.ts)
// and nft's delete-then-recreate ruleset (wg/firewall.ts) are not safe to run concurrently,
// and two overlapping HTTP requests mutating different servers would otherwise race here.
// A queued converge always re-resolves the server row rather than closing over a stale one
// captured before it was queued, so it never applies out-of-date config.
let chain: Promise<void> = Promise.resolve();

const queue = <T>(run: () => Promise<T>): Promise<T> => {
	const result = chain.then(run, run);
	chain = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
};

/** Start it if it isn't up, reload it if it is - the same decision for every interface kind. */
const applyInterface = async (interfaceName: string, config: string) => {
	if (await isInterfaceUp(interfaceName)) {
		await reloadInterface(interfaceName, config);
	} else {
		await startInterface(interfaceName, config);
	}
};

/**
 * The two things this manager applies host-wide: one nft ruleset across every server, and one
 * set of policy routes in the host's routing tables. Both are functions of the same fleet
 * snapshot, so it is read once and handed to both - they used to load it independently, which
 * meant the same N+1 query twice per converge and two appliers that could disagree.
 *
 * Neither applier throws (both catch and log internally), so a failure here degrades to a
 * stale-but-consistent ruleset rather than failing the mutation that triggered it.
 */
const applyHostState = async () => {
	const fleet = await loadFleet();

	await sweepOrphanedExitLinks(fleet.flatMap((graph) => [graph.server.interfaceName, ...exitTopologyOf(graph.peers).exitNodes.flatMap((node) => (node.link ? [node.link.interfaceName] : []))]));

	await syncFirewall(fleet);

	// Last, and specifically after the interfaces are up: exit routing installs
	// `ip route ... dev <interfaceName>`, which needs the device to already exist.
	await syncExitRouting(fleet);
};

/**
 * Deletes exit-link interfaces the db no longer describes. reconcileExitLinks already releases
 * the link of a peer that stopped being an exit node, but it cannot see one whose peer row was
 * deleted while this process was down, and the config/ruleset would then keep ignoring a live
 * interface that still owns `0.0.0.0/0`.
 *
 * Only ever touches `wgx`-shaped names that no server and no exit node currently claims, so an
 * interface somebody else on this host manages - including a server that happens to be named
 * like a link - is never a candidate.
 *
 * The routing table that went with an orphan is not recoverable here (its id died with the
 * row), so a leftover `ip rule` can survive a crash. It points at a table this reconcile
 * leaves empty, so it matches nothing and the packet falls through to main; wgManager.stop()
 * clears them on any orderly shutdown.
 */
const sweepOrphanedExitLinks = async (claimed: string[]) => {
	try {
		const keep = new Set(claimed);

		for (const interfaceName of await listInterfaces()) {
			if (!isExitLinkInterface(interfaceName) || keep.has(interfaceName)) continue;

			log.warn(`Deleting orphaned exit link ${interfaceName} - no peer claims it any more`);
			await stopInterface(interfaceName);
		}
	} catch (error) {
		log.error(`Failed to sweep orphaned exit links: ${error}`);
	}
};

/**
 * Brings one server's interfaces and the host-wide firewall/routing state in sync with the db:
 * allocates or releases exit links, starts each interface that isn't up yet and reloads the
 * ones that are, then re-applies both host-wide artefacts.
 *
 * A server is *several* interfaces now: its own, carrying every ordinary peer, plus one per
 * exit node (wg/exitLinks.ts). They converge together because they are one unit of meaning -
 * moving a peer between them is exactly what toggling `isExitNode` does, and doing half of that
 * would leave the peer either on both interfaces or on neither.
 *
 * **This is the only sync any route handler should call**, whatever it changed. It used to be
 * a choice - `converge()` for peer/server config, `syncFirewall()` alone for pure policy
 * changes - decided by hand at ten call sites against a rule that lived only in this comment,
 * where picking wrong produced a silent routing bug rather than a failing test. A policy-only
 * mutation now also reloads the interface, which is a `wg syncconf` with identical content:
 * cheap, idempotent, and it puts every nft mutation on the serialized chain above instead of
 * letting a policy handler's ruleset rebuild race a concurrent converge.
 */
export const converge = async (serverId: string): Promise<ConvergeResult> =>
	queue(async () => {
		const server = await resolveServer(serverId);
		if (!server) return { ok: false, reason: 'Server not found' };

		// First, because everything below renders from those columns: a peer that just became an
		// exit node needs its interface allocated before its server's config is generated, and
		// generating that config is also what removes it from the shared interface.
		const reconcile = await reconcileExitLinks(server.id);
		for (const failure of reconcile.failures) {
			log.warn(`Peer ${failure.peerId} is marked as an exit node but has no usable link: ${failure.message}`);
		}

		try {
			// Released links go down before anything comes up, so an interface name or udp port
			// freed here is reusable within this same converge.
			for (const interfaceName of reconcile.releasedInterfaces) {
				if (await isInterfaceUp(interfaceName)) await stopInterface(interfaceName);
			}
			await resetExitRouting(reconcile.releasedRouteTableIds);

			await applyInterface(server.interfaceName, await generateServerConfig(server));

			const peers = await db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, server.id) });
			for (const node of exitTopologyOf(peers).exitNodes) {
				// unprovisioned link - reconcileExitLinks already reported why
				if (!node.link) continue;
				await applyInterface(node.link.interfaceName, generateExitLinkConfig(node));
			}
		} catch (error) {
			log.error(`Failed to converge interfaces for ${server.interfaceName}: ${error}`);
			return { ok: false, reason: `Failed to apply interface configuration: ${error}` };
		}

		await applyHostState();

		return { ok: true };
	});

/**
 * The host-wide half alone, without touching any interface. Only correct where every interface
 * has just been brought up by other means - that is, at boot (wg/manager.ts). Route handlers
 * want converge() above.
 */
export const convergeHost = async (): Promise<ConvergeResult> =>
	queue(async () => {
		await applyHostState();
		return { ok: true };
	});

/**
 * Takes one interface down and clears the policy routing that pointed at it - for the one
 * caller that has to clean up state converge cannot infer, because the row describing it is
 * about to be deleted (api/serversPeers.ts's peer delete).
 */
export const tearDownExitLink = async (link: { interfaceName: string; routeTableId: number }) =>
	queue(async () => {
		try {
			if (await isInterfaceUp(link.interfaceName)) await stopInterface(link.interfaceName);
			await resetExitRouting([link.routeTableId]);
		} catch (error) {
			log.error(`Failed to tear down exit link ${link.interfaceName}: ${error}`);
		}
	});
