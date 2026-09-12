import { db } from '@server/db';
import { type ServerPeer } from '@server/db/schema';
import { isInterfaceUp, listInterfaces, resetFirewall, stopInterface, wgShow } from './shell';
import { resetExitRouting } from './exitRouting';
import { allExitLinks, isExitLinkInterface } from './exitLinks';
import { converge } from './converge';
import { recordServerTraffic, rollupAndPrune, trafficStatsEnabled } from './traffic';
import { createLog } from '@server/lib/log';

const log = createLog('wg');

const constructWgManager = () => {
	let servers: ServerPeer[] = [];
	const peerInfo: Record<string, { connected: boolean; wgTransferRx: number; wgTransferTx: number; wgLatestHandshake: number; wgEndpoint: string }> = {};

	const _start = async () => {
		servers = await db.query.serverPeersTable.findMany();

		// Delete every interface we might own before starting anything, rather than reloading
		// whatever survived a restart: `wg syncconf` applies peers but not the `[Interface]`
		// half, so an interface left over from an older config could keep an address or a
		// `Table = off` this boot no longer wants. Exit links are swept by name, since the peer
		// that owned one may have been deleted while this process was down.
		const known = new Set(servers.map((s) => s.interfaceName));
		for (const name of await listInterfaces()) {
			if (!known.has(name) && !isExitLinkInterface(name)) continue;
			log.info(`${name} is up, deleting link before start`);
			await stopInterface(name);
		}

		// converge brings up a server's own interface *and* one per exit node, having first
		// reconciled which exit links should exist at all - including provisioning one for an
		// exit node that predates those columns (see wg/exitLinks.ts).
		for (const server of servers) {
			log.info(`Starting server ${server.interfaceName}`);
			const result = await converge(server.id);
			if (!result.ok) log.error(`Failed to start ${server.interfaceName}: ${result.reason}`);
		}

		loop();
	};

	const refreshInfo = async () => {
		log.info('Checking servers');
		const linksByServer = new Map<string, string[]>();
		for (const link of await allExitLinks()) {
			linksByServer.set(link.serverPeerId, [...(linksByServer.get(link.serverPeerId) ?? []), link.interfaceName]);
		}

		for (const server of servers) {
			const wgShowResult = await wgShow(server.interfaceName);

			if (!wgShowResult) {
				log.info(`Server is down! Starting server ${server.interfaceName}`);
				const convergeResult = await converge(server.id);
				if (!convergeResult.ok) {
					log.error(`Failed to restart server ${server.interfaceName}: ${convergeResult.reason}`);
				}
				continue;
			}

			// This server's exit nodes are peers of their own interfaces, not of this one, so
			// their status and counters have to be collected from each link and merged in - they
			// are still peers *of this server* everywhere the api and ui are concerned.
			const samples = [...wgShowResult.peers];
			for (const linkName of linksByServer.get(server.id) ?? []) {
				const linkResult = await wgShow(linkName);
				if (linkResult) samples.push(...linkResult.peers);
			}

			for (const peer of samples) {
				peerInfo[peer.publicKey] = {
					connected: Date.now() - peer.latestHandshake * 1000 < 180000,
					wgEndpoint: peer.endpoint,
					wgTransferRx: peer.transferRx,
					wgTransferTx: peer.transferTx,
					wgLatestHandshake: peer.latestHandshake,
				};
			}

			if (trafficStatsEnabled) {
				try {
					await recordServerTraffic(
						server,
						samples.map((p) => ({ publicKey: p.publicKey, transferRx: p.transferRx, transferTx: p.transferTx })),
					);
				} catch (error) {
					log.error(`Failed to record traffic for ${server.interfaceName}: ${error}`);
				}
			}
		}
	};

	let loopTimeout: Timer | null = null;
	let tickCount = 0;
	const ROLLUP_EVERY_N_TICKS = 120; // ~1h at the 30s tick cadence below

	const loop = async () => {
		await refreshInfo();

		tickCount++;
		if (trafficStatsEnabled && tickCount % ROLLUP_EVERY_N_TICKS === 0) {
			try {
				await rollupAndPrune();
			} catch (error) {
				log.error(`Traffic rollup/prune failed: ${error}`);
			}
		}

		loopTimeout = setTimeout(loop, 30000);
	};

	const start = () => {
		_start();
	};

	const stop = async () => {
		if (loopTimeout) {
			clearTimeout(loopTimeout);
		}

		const links = await allExitLinks();

		for (const interfaceName of [...servers.map((s) => s.interfaceName), ...links.map((l) => l.interfaceName)]) {
			if (await isInterfaceUp(interfaceName)) {
				log.info(`Stopping ${interfaceName}`);
				await stopInterface(interfaceName);
			}
		}

		await resetFirewall();
		// Deleting the interfaces above drops each exit table's routes along with the device, but
		// the `ip rule` entries pointing at those tables outlive it - clear them explicitly.
		await resetExitRouting(links.map((l) => l.routeTableId));
	};

	return { start, stop, peerInfo };
};

export const wgManager = constructWgManager();
