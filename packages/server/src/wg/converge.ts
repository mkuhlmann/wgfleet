import { resolveServer } from '@server/db/servers';
import { loadFleet } from '@server/db/fleet';
import { isInterfaceUp, reloadServer, startServer } from './shell';
import { syncFirewall } from './firewall';
import { syncExitRouting } from './exitRouting';
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
		() => undefined
	);
	return result;
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

	await syncFirewall(fleet);

	// Last, and specifically after the interface is up: exit routing installs
	// `ip route ... dev <interfaceName>`, which needs the device to already exist.
	await syncExitRouting(fleet);
};

/**
 * Brings one server's wg interface and the host-wide firewall/routing state in sync with the
 * db: starts the interface if it isn't up yet, otherwise reloads it, then re-applies both
 * host-wide artefacts.
 *
 * **This is the only sync any route handler should call**, whatever it changed. It used to be
 * a choice - `converge()` for peer/server config, `syncFirewall()` alone for pure policy
 * changes - decided by hand at ten call sites against a rule that lived only in this comment,
 * where picking wrong produced a silent routing bug rather than a failing test. A policy-only
 * mutation now also reloads the interface, which is a `wg syncconf` with identical content:
 * cheap, idempotent, and it puts every nft mutation on the serialized chain above instead of
 * letting a policy handler's ruleset rebuild race a concurrent converge's.
 */
export const converge = async (serverId: string): Promise<ConvergeResult> =>
	queue(async () => {
		const server = await resolveServer(serverId);
		if (!server) return { ok: false, reason: 'Server not found' };

		try {
			if (await isInterfaceUp(server.interfaceName)) {
				await reloadServer(server);
			} else {
				await startServer(server);
			}
		} catch (error) {
			log.error(`Failed to converge interface ${server.interfaceName}: ${error}`);
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
