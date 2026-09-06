import { db } from '@server/db';
import { peersTable, type ServerPeer } from '@server/db/schema';
import { isInterfaceUp, resetFirewall, startServer, stopServer, wgShow } from './shell';
import { syncFirewall } from './firewall';
import { recordServerTraffic, rollupAndPrune, trafficStatsEnabled } from './traffic';
import { createLog } from '@server/lib/log';
import { eq } from 'drizzle-orm';

const log = createLog('wg');

const constructWgManager = () => {
	let servers: ServerPeer[] = [];
	const peerInfo: Record<string, { connected: boolean; wgTransferRx: number; wgTransferTx: number; wgLatestHandshake: number; wgEndpoint: string }> = {};

	const _start = async () => {
		servers = await db.query.serverPeersTable.findMany();

		for (const server of servers) {
			log.info(`Checking server ${server.interfaceName}`);
			if (await isInterfaceUp(server.interfaceName)) {
				log.info(`Server ${server.interfaceName} is up, deleting link.`);
				await stopServer(server);
			}
			log.info(`Starting server ${server.interfaceName}`);
			await startServer(server);
		}

		await syncFirewall();

		loop();
	};

	const refreshInfo = async () => {
		log.info('Checking servers');
		for (const server of servers) {
			const wgShowResult = await wgShow(server.interfaceName);

			if (!wgShowResult) {
				log.info(`Server is down! Starting server ${server.interfaceName}`);
				await startServer(server);
				continue;
			}

			for (const peer of wgShowResult.peers) {
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
						wgShowResult.peers.map((p) => ({ publicKey: p.publicKey, transferRx: p.transferRx, transferTx: p.transferTx }))
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

		for (const server of servers) {
			if (await isInterfaceUp(server.interfaceName)) {
				log.info(`Stopping server ${server.interfaceName}`);
				await stopServer(server);
			}
		}

		await resetFirewall();
	};

	return { start, stop, peerInfo };
};

export const wgManager = constructWgManager();
