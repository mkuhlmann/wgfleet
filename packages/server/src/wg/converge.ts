import { resolveServer } from '@server/db/servers';
import { isInterfaceUp, reloadServer, startServer } from './shell';
import { syncFirewall } from './firewall';
import { createLog } from '@server/lib/log';

const log = createLog('wg:converge');

export type ConvergeResult = { ok: true } | { ok: false; reason: string };

// Serializes converge calls globally - wg-quick's temp-config-file scheme (shell.real.ts)
// and nft's delete-then-recreate ruleset (wg/firewall.ts) are not safe to run concurrently,
// and two overlapping HTTP requests mutating different servers would otherwise race here.
// A queued converge always re-resolves the server row rather than closing over a stale one
// captured before it was queued, so it never applies out-of-date config.
let chain: Promise<void> = Promise.resolve();

/**
 * Brings one server's wg interface and the (global) firewall ruleset in sync with the db:
 * starts the interface if it isn't up yet, otherwise reloads it, then resyncs the firewall.
 * This is the one place that decides start-vs-reload and the only place a failure in either
 * step is observable - every route handler that changes a server's or a peer's config calls
 * this instead of reaching for wg/shell and wg/firewall directly. Pure policy changes (tags,
 * grants) don't touch the interface and should call syncFirewall() alone instead.
 */
export const converge = async (serverId: string): Promise<ConvergeResult> => {
	const run = async (): Promise<ConvergeResult> => {
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

		// syncFirewall never throws (it catches and logs internally - see firewall.ts) so this
		// is always reached, but await it anyway rather than leaving it fire-and-forget.
		await syncFirewall();

		return { ok: true };
	};

	const result = chain.then(run, run);
	chain = result.then(
		() => undefined,
		() => undefined
	);
	return result;
};
