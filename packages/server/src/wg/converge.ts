import { resolveServer } from '@server/db/servers';
import { loadFleet } from '@server/db/fleet';
import { applyExitRouting, applyFirewall, listInterfaces, reloadInterface, startInterface, stopInterface } from './shell';
import { resetExitRouting, warnOnRoutingSysctls } from './exitRouting';
import { reconcileExitLinks } from './exitLinks';
import { planConverge, type ConvergePlan, type InterfaceStep } from './plan';
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

const runStep = async (step: InterfaceStep) => {
	switch (step.action) {
		case 'stop':
			if (step.reason === 'orphaned') log.warn(`Deleting orphaned exit link ${step.interfaceName} - no peer claims it any more`);
			await stopInterface(step.interfaceName);
			return;
		case 'start':
			await startInterface(step.interfaceName, step.config);
			return;
		case 'reload':
			await reloadInterface(step.interfaceName, step.config);
			return;
		// Its key and udp port changed, and `wg syncconf` would apply neither - see wg/plan.ts.
		case 'restart':
			await stopInterface(step.interfaceName);
			await startInterface(step.interfaceName, step.config);
			return;
	}
};

/**
 * The host-wide half: one nft ruleset across every server, and one set of policy routes in the
 * host's routing tables. Both come out of the same plan, and therefore out of the same fleet
 * snapshot - they used to load it independently, which meant the same N+1 query twice per
 * converge and two appliers that could in principle disagree.
 *
 * Neither applier throws: a failure here degrades to a stale-but-consistent ruleset rather than
 * failing the mutation that triggered it. It is applied even when an interface step failed
 * above, which is the point - a peer that was just deleted must lose its grants and its
 * `ip rule` whether or not its server's interface came up.
 */
const applyHostState = async (plan: ConvergePlan) => {
	await resetExitRouting(plan.drainRouteTableIds);

	try {
		await applyFirewall(plan.ruleset);
	} catch (error) {
		log.error(`Failed to sync firewall ruleset: ${error}`);
	}

	try {
		// Last, and specifically after the interfaces are up: exit routing installs
		// `ip route ... dev <interfaceName>`, which needs the device to already exist. The plan
		// puts the interface steps first for this reason.
		await applyExitRouting(plan.routing);
		await warnOnRoutingSysctls(plan.routingChecks);
	} catch (error) {
		log.error(`Failed to apply exit routing: ${error}`);
	}
};

/**
 * Brings one server's interfaces and the host-wide firewall/routing state in sync with the db.
 *
 * A server is *several* interfaces: its own, carrying every ordinary peer, plus one per exit
 * node (wg/exitLinks.ts). They converge together because they are one unit of meaning - moving
 * a peer between them is exactly what toggling `isExitNode` does, and doing half of that would
 * leave the peer either on both interfaces or on neither.
 *
 * **This is the only sync any route handler should call**, whatever it changed. It used to be
 * a choice - `converge()` for peer/server config, `syncFirewall()` alone for pure policy
 * changes - decided by hand at ten call sites against a rule that lived only in this comment,
 * where picking wrong produced a silent routing bug rather than a failing test. A policy-only
 * mutation now also reloads the interface, which is a `wg syncconf` with identical content:
 * cheap, idempotent, and it puts every nft mutation on the serialized chain above instead of
 * letting a policy handler's ruleset rebuild race a concurrent converge.
 *
 * Three steps, in this order and for stated reasons:
 *
 *  1. `reconcileExitLinks` - it *writes* (allocating or releasing a peer's five link columns),
 *     so everything below has to be read after it. A peer that just became an exit node needs
 *     its interface allocated before its server's config is generated, and generating that
 *     config is also what removes it from the shared interface.
 *  2. one fleet snapshot and one look at the host, turned into a `ConvergePlan` (wg/plan.ts) -
 *     pure, and where every ordering decision now lives.
 *  3. apply it.
 */
export const converge = async (serverId: string): Promise<ConvergeResult> =>
	queue(async () => {
		const server = await resolveServer(serverId);
		if (!server) return { ok: false, reason: 'Server not found' };

		const reconcile = await reconcileExitLinks(server.id);
		for (const failure of reconcile.failures) {
			log.warn(`Peer ${failure.peerId} is marked as an exit node but has no usable link: ${failure.message}`);
		}

		const plan = planConverge({ serverId: server.id, fleet: await loadFleet(), upInterfaces: await listInterfaces(), reconcile });

		let failure: string | null = null;
		try {
			for (const step of plan.interfaces) {
				await runStep(step);
			}
		} catch (error) {
			log.error(`Failed to converge interfaces for ${server.interfaceName}: ${error}`);
			failure = `Failed to apply interface configuration: ${error}`;
		}

		// Deliberately not in the catch's shadow: see applyHostState.
		await applyHostState(plan);

		return failure ? { ok: false, reason: failure } : { ok: true };
	});

/**
 * Takes one interface down and clears the policy routing that pointed at it - for the one
 * caller that has to clean up state converge cannot infer, because the row describing it is
 * about to be deleted (api/serversPeers.ts's peer delete).
 */
export const tearDownExitLink = async (link: { interfaceName: string; routeTableId: number }) =>
	queue(async () => {
		try {
			if ((await listInterfaces()).includes(link.interfaceName)) await stopInterface(link.interfaceName);
			await resetExitRouting([link.routeTableId]);
		} catch (error) {
			log.error(`Failed to tear down exit link ${link.interfaceName}: ${error}`);
		}
	});
